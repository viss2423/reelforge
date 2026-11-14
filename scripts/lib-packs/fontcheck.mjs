/**
 * Proves every shipped font face is what libass actually picks for (family, weight, italic).
 *
 * Renders one ASS line per face through FFmpeg's `ass` filter at verbose log level and
 * parses libass's `fontselect: (Family, weight, italic) -> PostScriptName` decisions. A
 * mismatch means styles naming that family/weight would silently render in a fallback font.
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * @param {{ file: string, family: string, weight: number, italic: boolean, postscriptName: string }[]} faces
 * @returns {Promise<string[]>} errors (empty = all faces resolve to themselves)
 */
export async function verifyFontsWithLibass(faces) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'reelforge-fontcheck-'))
  try {
    // libass's fontsdir is NOT recursive, so the family folders are flattened here.
    await mkdir(path.join(tmp, 'fonts'))
    await Promise.all(
      faces.map((f) => copyFile(f.file, path.join(tmp, 'fonts', path.basename(f.file)))),
    )
    const events = faces
      .map(
        (f, i) =>
          `Dialogue: 0,0:00:00.00,0:00:01.00,D,,0,0,0,,{\\pos(20,${20 + i * 40})\\fn${f.family}\\b${f.weight}\\i${f.italic ? 1 : 0}}Aa ${f.family}`,
      )
      .join('\n')
    await writeFile(
      path.join(tmp, 'check.ass'),
      `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: D,sans-serif,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`,
    )
    const log = await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-v',
        'verbose',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=540x960:d=0.04',
      ]
      args.push('-vf', 'ass=check.ass:fontsdir=fonts', '-frames:v', '1', '-f', 'null', '-')
      const child = spawn('ffmpeg', args, {
        cwd: tmp,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      child.stderr.setEncoding('utf8').on('data', (d) => (out += d))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out))))
    })
    /** "Family|weight|italic" → selected PostScript name */
    const picked = new Map()
    for (const m of log.matchAll(/fontselect: \((.+?), (\d+), (\d+)\) -> ([^,]+),/g))
      picked.set(`${m[1]}|${m[2]}|${m[3] !== '0'}`, m[4])
    const errors = []
    for (const f of faces) {
      const got = picked.get(`${f.family}|${f.weight}|${f.italic}`)
      if (got !== f.postscriptName)
        errors.push(
          `libass resolved ${f.family} ${f.weight}${f.italic ? ' italic' : ''} to "${got ?? 'nothing'}", expected "${f.postscriptName}" (${path.basename(f.file)})`,
        )
    }
    return errors
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
