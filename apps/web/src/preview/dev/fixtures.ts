/**
 * Generates the dev harness' demo media with FFmpeg lavfi sources into `dev/.media/`
 * (git-ignored), encoded exactly like the server's proxies: H.264 High, GOP 15, no B-frames,
 * yuv420p, AAC 48 kHz, faststart, ≤ 960 px long side.
 *
 *   node apps/web/src/preview/dev/fixtures.ts [--force]
 *
 * Also writes `demo.json` describing the assets so the harness can build a demo project.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MEDIA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.media')

const PROXY_V = ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-g', '15']
const PROXY_V2 = ['-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
const lavfi = (graph: string): string[] => ['-f', 'lavfi', '-i', graph]
const AAC = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000']

interface Fixture {
  file: string
  kind: 'video' | 'image' | 'audio'
  width?: number
  height?: number
  duration?: number
  hasAudio?: boolean
  args: string[]
}

const S = 8 // seconds per video fixture

export const FIXTURES: Fixture[] = [
  {
    file: 'portrait.mp4',
    kind: 'video',
    width: 540,
    height: 960,
    duration: S * 1e6,
    hasAudio: true,
    args: [
      ...lavfi(`testsrc2=size=540x960:rate=30:duration=${S}`),
      ...lavfi(`sine=frequency=440:sample_rate=48000:duration=${S}`),
      ...PROXY_V,
      ...PROXY_V2,
      ...AAC,
      '-shortest',
    ],
  },
  {
    file: 'landscape.mp4',
    kind: 'video',
    width: 960,
    height: 540,
    duration: S * 1e6,
    hasAudio: true,
    args: [
      ...lavfi(`mandelbrot=size=960x540:rate=30,trim=duration=${S}`),
      ...lavfi(`sine=frequency=660:sample_rate=48000:duration=${S}`),
      ...PROXY_V,
      ...PROXY_V2,
      ...AAC,
      '-shortest',
    ],
  },
  {
    file: 'greenscreen.mp4',
    kind: 'video',
    width: 540,
    height: 960,
    duration: S * 1e6,
    hasAudio: false,
    args: [
      ...lavfi(`color=c=0x00ff00:size=540x960:rate=30:duration=${S}`),
      ...lavfi(`testsrc=size=240x240:rate=30:duration=${S}`),
      '-filter_complex',
      '[0][1]overlay=x=150+100*sin(t*2):y=360',
      ...PROXY_V,
      ...PROXY_V2,
    ],
  },
  {
    file: 'sticker.png',
    kind: 'image',
    width: 400,
    height: 400,
    args: [
      ...lavfi('color=c=0xff3366@0.0:size=400x400,format=rgba'),
      '-vf',
      "geq=r='255':g='200*X/W':b='80':a='if(lt(hypot(X-200,Y-200),180),255,0)'",
      '-frames:v',
      '1',
    ],
  },
  {
    file: 'music.m4a',
    kind: 'audio',
    duration: 20e6,
    hasAudio: true,
    args: [
      ...lavfi('sine=frequency=220:beep_factor=4:sample_rate=48000:duration=20'),
      ...AAC,
      '-movflags',
      '+faststart',
    ],
  },
]

/** Generate missing fixtures (all with `force`). Returns the media directory. */
export function generateFixtures(force = false): string {
  mkdirSync(MEDIA_DIR, { recursive: true })
  for (const f of FIXTURES) {
    const out = path.join(MEDIA_DIR, f.file)
    if (!force && existsSync(out)) continue
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...f.args, out], {
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    })
  }
  const demo = FIXTURES.map(({ args: _args, ...rest }) => rest)
  writeFileSync(path.join(MEDIA_DIR, 'demo.json'), JSON.stringify(demo, null, 2))
  return MEDIA_DIR
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = generateFixtures(process.argv.includes('--force'))
  process.stdout.write(`demo media in ${dir}\n`)
}
