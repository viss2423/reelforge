/**
 * FFmpeg integration: every caption mode and every builtin text animation is rendered by
 * FFmpeg's libass (`-vf ass=…:fontsdir=…`) over a lavfi canvas. Each case must exit 0, print
 * no error lines, and actually draw text (some bright pixels on the black canvas).
 *
 * Fonts: the shipped pack fonts are used when `packs/fonts` exists in the repo; otherwise the
 * test falls back to a system family (Arial) — libass substitutes any available font, so the
 * checks are font-agnostic.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUILTIN_ANIMATIONS, CaptionStyle, type Project } from '../src/index.ts'
import { ass, captionProject, textProject } from './ass-fixtures.ts'

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg'
const hasFfmpeg = spawnSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0
if (!hasFfmpeg) {
  console.warn(`[ass-ffmpeg] skipped: '${FFMPEG}' not found on PATH (set FFMPEG_PATH to enable)`)
}

const PACK_FONTS = resolvePath(import.meta.dirname, '../../../packs/fonts')
const usePackFonts = existsSync(join(PACK_FONTS, 'Montserrat'))
const FAMILY = usePackFonts ? 'Montserrat' : 'Arial'

/** Output frame size: libass renders at full 1080×1920, then frames are downscaled for the check. */
const OUT_W = 135
const OUT_H = 240
const FPS = 10

let dir = ''
let fontsDir = ''

beforeAll(async () => {
  if (!hasFfmpeg) return
  dir = await mkdtemp(join(tmpdir(), 'rf-ass-'))
  fontsDir = usePackFonts ? PACK_FONTS : join(dir, 'fonts')
  if (!usePackFonts) await mkdir(fontsDir)
})

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

interface RenderResult {
  code: number | null
  stderr: string
  /** Per-frame maximum luma. */
  peaks: number[]
}

/**
 * A path as a quoted filter option value: forward slashes, option-level escaping of `:` and
 * `'` (Windows drive letters), single-quoted at graph level (spaces, commas).
 */
const filterPath = (path: string): string =>
  `'${path.replaceAll('\\', '/').replace(/[:']/g, '\\$&')}'`

/**
 * Render `durationUs` of the project's subtitles over black with FFmpeg and return the exit
 * code, stderr and per-frame peak luma.
 */
async function render(name: string, p: Project, durationUs: number): Promise<RenderResult> {
  const assPath = join(dir, `${name}.ass`)
  await writeFile(assPath, ass(p))
  const args = [
    '-hide_banner',
    '-nostats',
    '-v',
    'warning',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=1080x1920:r=${FPS}:d=${durationUs / 1e6}`,
    '-vf',
    `ass=filename=${filterPath(assPath)}:fontsdir=${filterPath(fontsDir)},scale=${OUT_W}:${OUT_H}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => chunks.push(b))
    child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    child.on('error', reject)
    child.on('close', (code) => {
      const raw = Buffer.concat(chunks)
      const frame = OUT_W * OUT_H
      const peaks: number[] = []
      for (let off = 0; off + frame <= raw.length; off += frame) {
        let max = 0
        for (let i = off; i < off + frame; i++) if (raw[i]! > max) max = raw[i]!
        peaks.push(max)
      }
      resolve({ code, stderr, peaks })
    })
  })
}

/**
 * What a successful render looks like, compared as one object so a failure shows everything:
 * exit 0 (else the full stderr), no error lines, every frame produced, and bright pixels
 * somewhere (white text on black).
 */
const outcome = (r: RenderResult) => ({
  exit: r.code === 0 ? 0 : r.stderr,
  errors: r.stderr.split(/\r?\n/).filter((l) => /error/i.test(l)),
  frames: r.peaks.length,
  drewText: Math.max(0, ...r.peaks) > 128,
})
const rendered = (frames: number) => ({ exit: 0, errors: [], frames, drewText: true })

const MODES = CaptionStyle.shape.mode.unwrap().options

describe.skipIf(!hasFfmpeg)('libass renders the generated documents (FFmpeg)', () => {
  it('negative control: a document without events draws nothing', async () => {
    const r = await render('empty', textProject({ text: ' ' }, FAMILY).p, 500_000)
    expect(outcome(r)).toEqual({ ...rendered(5), drewText: false })
  })

  it.concurrent.each(MODES)('caption mode %s', async (mode) => {
    const p = captionProject(
      {
        mode,
        maxLines: 2,
        activeBackgroundColor: '#FF00FF80',
        base: { backgroundColor: '#00000099' },
      },
      FAMILY,
    )
    const r = await render(`cap-${mode}`, p, 2_100_000)
    expect(outcome(r)).toEqual(rendered(21))
  })

  it.concurrent.each(BUILTIN_ANIMATIONS.map((a) => [a.id, a.kind] as const))(
    'text animation %s (%s)',
    async (id, kind) => {
      const { p, clip } = textProject(
        {
          text: 'Animate me\nplease',
          duration: 1_500_000,
          style: { shadowBlur: 4, strokeWidth: 6, strokeColor: '#000000FF' },
        },
        FAMILY,
      )
      const anim = { ref: `builtin/${id}`, duration: 600_000 }
      if (kind === 'in') clip.animationIn = anim
      else if (kind === 'out') clip.animationOut = anim
      else clip.animationLoop = anim
      const r = await render(`anim-${id}`, p, 1_500_000)
      expect(outcome(r)).toEqual(rendered(15))
    },
  )

  it('renders rotated, flipped, boxed multi-track text with keyframed transforms', async () => {
    const { p, clip } = textProject(
      {
        text: 'Keyframes {and} \\ escapes',
        style: { backgroundColor: '#202020CC', align: 'left' },
      },
      FAMILY,
    )
    clip.transform.rotation.keyframes = [
      { t: 0, value: -20, easing: 'linear' },
      { t: 2_000_000, value: 20, easing: 'easeOutElastic' },
    ]
    clip.transform.scale.keyframes = [
      { t: 0, value: 0.5, easing: 'linear' },
      { t: 1_000_000, value: 1.5, easing: 'easeOutBack' },
    ]
    clip.transform.flipH = true
    const r = await render('transform', p, 2_000_000)
    expect(outcome(r)).toEqual(rendered(20))
  })
})
