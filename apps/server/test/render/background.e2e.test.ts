/**
 * AI background export: real projects with a synthetic subject matte (a white box on black,
 * generated with lavfi and stored exactly where the `matte` job writes it) → export job →
 * FFmpeg → pixel statistics. Proves the subject pixels are kept and the background is removed
 * / blurred / replaced, that text behind the subject is covered by the subject, and that
 * clips without a matte export untouched. No model needed.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@reelforge/core'
import type { ExportPayload } from '../../src/contracts.ts'
import { matteFile } from '../../src/ai/matte/index.ts'
import { runExport } from '../../src/render/index.ts'
import type { RenderDeps } from '../../src/render/pipeline.ts'
import {
  FIXTURES,
  addFixture,
  createEnv,
  fakeJob,
  ffmpeg,
  ffmpegAvailable,
  frameAt,
  makeProject,
  mainClips,
  meanRgb,
  type Env,
} from './harness.ts'

const HAVE_FFMPEG = ffmpegAvailable()
if (!HAVE_FFMPEG) console.warn('background e2e tests skipped: ffmpeg/ffprobe not found on PATH')

type Rgb = [number, number, number]

/** The subject: canvas box x 270..810, y 480..1440 (normalised 0.25..0.75 × 0.25..0.75). */
const SUBJECT = { x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 }
const CORNER = { x0: 0.02, y0: 0.02, x1: 0.2, y1: 0.12 }
/** The 400×400 text box of the ASS below (canvas 340..740 × 760..1160). */
const TEXT_BOX = { x0: 0.4, y0: 0.43, x1: 0.6, y1: 0.57 }

const dist = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const boxAss = (): string => `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:30.00,Default,,0,0,0,,{\\pos(340,760)\\p1}m 0 0 l 400 0 400 400 0 400{\\p0}
`
const emptyAss =
  boxAss().split('\n[Events]')[0] +
  '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'

/** `behind` layer → the white box, `front` → nothing, `all` → the box. */
const layerDeps: RenderDeps = {
  buildAss: (_p, ctx) => (ctx.layer === 'front' ? emptyAss : boxAss()),
}

describe.skipIf(!HAVE_FFMPEG)('AI background export (synthetic matte)', () => {
  let env: Env

  beforeAll(async () => {
    env = await createEnv()
    await Promise.all(FIXTURES.map((f) => addFixture(env, f)))
    // Solid-colour still used as the replacement image.
    await addFixture(env, {
      id: 'bgimg',
      kind: 'image',
      name: 'bg.png',
      args: ['-f', 'lavfi', '-i', 'color=c=0x20c040:s=640x640', '-frames:v', '1'],
      meta: { width: 640, height: 640, hasVideo: false },
    })
    // The matte of `port` (1080×1920, 30 fps, 6 s) exactly as the matte job stores it.
    const out = matteFile(env.paths, 'port')
    await mkdir(path.dirname(out), { recursive: true })
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=1080x1920:r=30:d=6',
      '-vf',
      'drawbox=x=324:y=576:w=432:h=768:color=white:t=fill,format=gray',
      '-c:v',
      'ffv1',
      out,
    ])
    env.store.patchAsset('port', {
      matte: { status: 'ready', model: 'modnet', width: 1080, height: 1920, fps: 30, version: 1 },
    })
  }, 120_000)

  afterAll(async () => {
    await env?.dispose()
  })

  const exportFrame = async (
    clip: Record<string, unknown>,
    opts: { text?: boolean; background?: string } = {},
  ): Promise<Awaited<ReturnType<typeof frameAt>>> => {
    const project: Project = makeProject(
      [
        { kind: 'main', clips: mainClips([{ duration: 1_000_000, assetId: 'port', ...clip }]) },
        ...(opts.text
          ? [
              {
                kind: 'text' as const,
                clips: [
                  {
                    id: 'txt',
                    type: 'text',
                    text: 'x',
                    start: 0,
                    duration: 1_000_000,
                    behindSubject: true,
                  },
                ],
              },
            ]
          : []),
      ],
      { settings: { background: opts.background ?? '#0000ff' } },
    )
    env.store.projects.set(project.id, project)
    const job = fakeJob<ExportPayload>(env, 'export', {
      projectId: project.id,
      settings: { resolution: '720p', quality: 'draft' } as ExportPayload['settings'],
    })
    const { file } = (await runExport(job.ctx, layerDeps)) as { file: string }
    return frameAt(file, 0.4, 108, 192)
  }

  /** Reference: the clip with no AI background. */
  const plain = (): ReturnType<typeof exportFrame> => exportFrame({})

  it('keeps the subject pixels and replaces the background with a colour', async () => {
    const [ref, out] = await Promise.all([
      plain(),
      exportFrame({ background: { mode: 'color', color: '#ff0000' } }),
    ])
    const refSubject = meanRgb(ref, SUBJECT)
    expect(dist(meanRgb(out, SUBJECT), refSubject)).toBeLessThan(12)
    expect(dist(meanRgb(out, CORNER), [255, 0, 0])).toBeLessThan(40)
    expect(dist(meanRgb(ref, CORNER), meanRgb(out, CORNER))).toBeGreaterThan(30)
  })

  it('remove makes the background transparent, showing the project background', async () => {
    const [ref, out] = await Promise.all([
      plain(),
      exportFrame({ background: { mode: 'remove' } }, { background: '#00ff00' }),
    ])
    expect(dist(meanRgb(out, SUBJECT), meanRgb(ref, SUBJECT))).toBeLessThan(12)
    expect(dist(meanRgb(out, CORNER), [0, 255, 0])).toBeLessThan(60)
  })

  it('blur keeps the subject sharp and blurs the rest of the clip', async () => {
    const [ref, out] = await Promise.all([
      plain(),
      exportFrame({ background: { mode: 'blur', blur: 100 } }),
    ])
    expect(dist(meanRgb(out, SUBJECT), meanRgb(ref, SUBJECT))).toBeLessThan(12)
    // testsrc2 is busy: blur pulls the corner towards the local mean, i.e. changes it.
    expect(dist(meanRgb(out, CORNER), meanRgb(ref, CORNER))).toBeGreaterThan(3)
    // …but it is still the clip's own colours, not a flat replacement.
    expect(dist(meanRgb(out, CORNER), meanRgb(ref, CORNER))).toBeLessThan(120)
  })

  it('image replaces the background with a cover-fitted image', async () => {
    const out = await exportFrame({ background: { mode: 'image', assetId: 'bgimg' } })
    expect(dist(meanRgb(out, CORNER), [0x20, 0xc0, 0x40])).toBeLessThan(30)
    const ref = await plain()
    expect(dist(meanRgb(out, SUBJECT), meanRgb(ref, SUBJECT))).toBeLessThan(12)
  })

  it('feather softens the matte edge without moving the subject interior', async () => {
    const out = await exportFrame({ background: { mode: 'color', color: '#ff0000', feather: 60 } })
    const ref = await plain()
    expect(dist(meanRgb(out, SUBJECT), meanRgb(ref, SUBJECT))).toBeLessThan(15)
    expect(dist(meanRgb(out, CORNER), [255, 0, 0])).toBeLessThan(40)
  })

  it('without a matte the clip exports untouched', async () => {
    env.store.patchAsset('port', { matte: undefined })
    try {
      const [ref, out] = await Promise.all([
        plain(),
        exportFrame({ background: { mode: 'color', color: '#ff0000' } }),
      ])
      expect(dist(meanRgb(out, CORNER), meanRgb(ref, CORNER))).toBeLessThan(6)
    } finally {
      env.store.patchAsset('port', {
        matte: { status: 'ready', model: 'modnet', width: 1080, height: 1920, fps: 30, version: 1 },
      })
    }
  })

  it('text behind subject: the subject covers the text, the background does not', async () => {
    const withText = await exportFrame({ background: { mode: 'keep' } }, { text: true })
    const ref = await plain()
    // The text box lies inside the subject: it must NOT show white there…
    expect(dist(meanRgb(withText, TEXT_BOX), meanRgb(ref, TEXT_BOX))).toBeLessThan(12)
    // …whereas without the subject pass (no matte) the same text is plainly visible.
    env.store.patchAsset('port', { matte: undefined })
    try {
      const noMatte = await exportFrame({}, { text: true })
      expect(dist(meanRgb(noMatte, TEXT_BOX), [255, 255, 255])).toBeLessThan(25)
    } finally {
      env.store.patchAsset('port', {
        matte: { status: 'ready', model: 'modnet', width: 1080, height: 1920, fps: 30, version: 1 },
      })
    }
  })

  it('exports with a geometry change (zoom + offset) keeping matte and picture aligned', async () => {
    const transform = {
      x: { value: 700, keyframes: [] },
      y: { value: 960, keyframes: [] },
      scale: { value: 0.5, keyframes: [] },
    }
    const out = await exportFrame({
      transform,
      background: { mode: 'color', color: '#ff0000' },
    })
    // The clip (scale 0.5, centre x 700) covers canvas x 430..970; its subject box lies at
    // x 592..808. Left of it the clip's own background is replaced by red; beyond the clip
    // the project background (blue) shows.
    const background = meanRgb(out, { x0: 0.41, y0: 0.4, x1: 0.54, y1: 0.6 })
    const subject = meanRgb(out, { x0: 0.56, y0: 0.4, x1: 0.74, y1: 0.6 })
    const beyond = meanRgb(out, { x0: 0.92, y0: 0.4, x1: 0.99, y1: 0.6 })
    expect(dist(background, [255, 0, 0])).toBeLessThan(40)
    expect(dist(subject, [255, 0, 0])).toBeGreaterThan(80)
    expect(dist(subject, [0, 0, 255])).toBeGreaterThan(80)
    expect(dist(beyond, [0, 0, 255])).toBeLessThan(40)
  })
})
