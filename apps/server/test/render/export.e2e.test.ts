/**
 * End-to-end render tests: real projects → export/preview job handlers → FFmpeg → ffprobe /
 * pixel / loudness checks on the output. Fixtures are generated with lavfi in beforeAll.
 */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, TransitionType } from '@reelforge/core'
import { TransitionType as TransitionTypeSchema } from '@reelforge/core'
import type { ExportPayload, PreviewPayload } from '../../src/contracts.ts'
import { runExport, runPreview } from '../../src/render/index.ts'
import { BUNDLED_PACKS } from '../../src/render/packs.ts'
import type { RenderDeps } from '../../src/render/pipeline.ts'
import {
  FIXTURES,
  addFixture,
  audioStream,
  createEnv,
  cube,
  detectHwH264,
  fakeJob,
  ffmpegAvailable,
  frameAt,
  integratedLoudness,
  mainClips,
  makeProject,
  meanRgb,
  probe,
  videoStream,
  writePack,
  type Env,
} from './harness.ts'

type Rgb = [number, number, number]

const HAVE_FFMPEG = ffmpegAvailable()
if (!HAVE_FFMPEG) console.warn('render e2e tests skipped: ffmpeg/ffprobe not found on PATH')

const FPS = 30
const FRAME = 1 / FPS

/** A handwritten ASS: a 400×400 white box (vector drawing, no fonts needed) at canvas
 * (340..740, 760..1160) between `from` and `to` seconds. */
const boxAss = (from = '0:00:00.00', to = '0:00:30.00'): string => `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${from},${to},Default,,0,0,0,,{\\pos(340,760)\\p1}m 0 0 l 400 0 400 400 0 400{\\p0}
`

const assDeps = (ass: string): RenderDeps => ({ buildAss: () => ass })

const BOX = { x0: 0.4, y0: 0.43, x1: 0.6, y1: 0.57 }

/** Video is frame-exact (CFR, exact frame count) and audio matches within 50 ms. */
const expectDuration = (p: Awaited<ReturnType<typeof probe>>, seconds: number): void => {
  const v = videoStream(p)
  expect(Math.abs(Number(v.duration) - seconds)).toBeLessThanOrEqual(FRAME + 1e-6)
  expect(Number(v.nb_frames)).toBe(Math.round(seconds * FPS))
  const a = audioStream(p)
  expect(a).toBeDefined()
  expect(Math.abs(Number(a!.duration) - seconds)).toBeLessThanOrEqual(0.05)
}

const TEXT_FONTS = ['Bebas Neue', 'Pacifico'] as const

const textTrack = {
  kind: 'text' as const,
  clips: [{ id: 'txt', type: 'text', text: 'hello', start: 0, duration: 1_000_000 }],
}

describe.skipIf(!HAVE_FFMPEG)('render e2e', { timeout: 180_000 }, () => {
  let env: Env
  let hw: string | undefined

  beforeAll(async () => {
    hw = await detectHwH264()
    if (!hw) console.warn('GPU encoder tests skipped: no working hardware H.264 encoder found')
    env = await createEnv(hw ? { h264: hw } : {})
    await Promise.all(FIXTURES.map((f) => addFixture(env, f)))
    await writePack(
      env,
      'testpack',
      {
        filters: [
          { id: 'invert', name: 'Invert', lut: 'luts/invert.cube' },
          { id: 'escape', name: 'Escape', lut: '../../outside.cube' },
        ],
        effects: [
          'shake',
          'zoomPulse',
          'rgbSplit',
          'flash',
          'blurIn',
          'vhs',
          'glow',
          'beatZoom',
          'strobe',
          'filmGrain',
        ].map((e) => ({ id: e, name: e, effect: e })),
        stickers: [
          { id: 'logo', name: 'Logo', file: 'stickers/logo.png', width: 200, height: 200 },
        ],
        animations: [
          {
            id: 'popIn',
            name: 'Pop in',
            kind: 'in',
            tracks: {
              scale: [
                { t: 0, value: 0.2 },
                { t: 1, value: 1, easing: 'easeOutBack' },
              ],
              opacity: [
                { t: 0, value: 0 },
                { t: 1, value: 1 },
              ],
            },
          },
        ],
      },
      { 'luts/invert.cube': cube(17, (r, g, b) => [1 - r, 1 - g, 1 - b]) },
    )
    // The sticker is the logo fixture copied into the pack.
    const { copyFile, cp, mkdir } = await import('node:fs/promises')
    await mkdir(path.join(env.paths.packs, 'testpack', 'stickers'), { recursive: true })
    await copyFile(
      path.join(env.paths.media, 'logo', 'original.png'),
      path.join(env.paths.packs, 'testpack', 'stickers', 'logo.png'),
    )
    // Two shipped font families in the pack layout (`fonts/<Family>/*.ttf`).
    for (const family of TEXT_FONTS) {
      await cp(
        path.join(BUNDLED_PACKS, 'fonts', family),
        path.join(env.paths.packs, 'fonts', family),
        {
          recursive: true,
        },
      )
    }
  }, 120_000)

  afterAll(async () => {
    await env?.dispose()
  })

  const exportProject = async (
    project: Project,
    settings: Partial<ExportPayload['settings']> = {},
    deps?: RenderDeps,
  ) => {
    env.store.projects.set(project.id, project)
    const job = fakeJob<ExportPayload>(env, 'export', {
      projectId: project.id,
      settings: { resolution: '720p', quality: 'draft', ...settings } as ExportPayload['settings'],
    })
    const result = await runExport(job.ctx, deps)
    return { result, job }
  }

  it('exports a mixed project with Reels-ready stream parameters', async () => {
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips([
          { duration: 2_000_000, in: 500_000 },
          {
            duration: 2_000_000,
            assetId: 'port',
            transitionIn: { type: 'fade', duration: 500_000 },
          },
          {
            duration: 1_500_000,
            type: 'image',
            assetId: 'img',
            autoMotion: 'zoomIn',
            transitionIn: { type: 'slideleft', duration: 300_000 },
          },
          { duration: 1_000_000, assetId: 'silent', fit: 'contain' },
        ]),
      },
    ])
    const { result, job } = await exportProject(project, { encoder: 'cpu' })
    // 6.5 s of clips minus 0.8 s of transition overlap.
    const expected = 5.7
    expect(result.duration).toBe(5_700_000)
    expect(result.width).toBe(720)
    expect(result.height).toBe(1280)
    expect(result.encoder).toBe('libx264')
    expect(result.fallbackUsed).toBe(false)
    expect(result.realtimeFactor).toBeGreaterThan(0)
    expect(result.file).toBe(path.join(env.paths.exports, `${job.ctx.job.id}.mp4`))
    expect(result.poster && existsSync(result.poster)).toBe(true)
    const p = await probe(result.file)
    const v = videoStream(p)
    expect(v).toMatchObject({
      codec_name: 'h264',
      profile: 'High',
      width: 720,
      height: 1280,
      pix_fmt: 'yuv420p',
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      color_space: 'bt709',
    })
    expect(audioStream(p)).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
    expectDuration(p, expected)
    expect(result.size).toBeGreaterThan(10_000)
    // No temp files left behind; progress is monotonic and completes.
    expect((await readdir(env.paths.exports)).filter((f) => f.endsWith('.part'))).toEqual([])
    expect(existsSync(path.join(env.paths.tmp, `render-${job.ctx.job.id}`))).toBe(false)
    const ps = job.progress.map((x) => x.p)
    expect(ps.every((x, i) => i === 0 || x >= ps[i - 1]!)).toBe(true)
    expect(ps.at(-1)).toBe(1)
    expect(job.progress.some((x) => /^Encoding · [\d.]+x · \d+ fps$/.test(x.message ?? ''))).toBe(
      true,
    )
  })

  it('normalises loudness to the target with a measured second pass', async () => {
    const project = makeProject([
      { kind: 'main', clips: mainClips([{ duration: 3_000_000, assetId: 'solid' }]) },
      {
        kind: 'audio',
        clips: [
          {
            id: 'a1',
            type: 'audio',
            assetId: 'music',
            start: 0,
            duration: 3_000_000,
            audio: { volume: 0.2 },
          },
        ],
      },
    ])
    const { result, job } = await exportProject(project, { loudnessTarget: -14 })
    expect(job.progress.some((x) => x.message?.startsWith('Analysing audio'))).toBe(true)
    const lufs = await integratedLoudness(result.file)
    expect(lufs).toBeGreaterThan(-15.5)
    expect(lufs).toBeLessThan(-12.5)
  })

  it('renders every transition type with overlap timing', async () => {
    const types = TransitionTypeSchema.options as readonly TransitionType[]
    const specs = types.map((type, i) => ({
      duration: 600_000,
      in: (i % 5) * 1_000_000,
      assetId: i % 2 ? 'port' : 'land',
      ...(i > 0 ? { transitionIn: { type: types[i - 1]!, duration: 200_000 } } : {}),
    }))
    // One more clip so the last type is used too.
    specs.push({
      duration: 600_000,
      in: 0,
      assetId: 'land',
      transitionIn: { type: types.at(-1)!, duration: 200_000 },
    })
    const project = makeProject([{ kind: 'main', clips: mainClips(specs) }])
    const { result } = await exportProject(project)
    const expected = (specs.length * 600_000 - (specs.length - 1) * 200_000) / 1e6
    expect(result.duration).toBe(expected * 1e6)
    expectDuration(await probe(result.file), expected)
  })

  it('renders a transition that follows hard cuts (concat → xfade time bases)', async () => {
    // Silence removal leaves several back-to-back pieces; a transition into the next clip
    // then joins a concat output to a clip chain.
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips([
          { duration: 700_000, in: 0 },
          { duration: 700_000, in: 1_000_000 },
          { duration: 700_000, in: 2_000_000 },
          {
            duration: 1_000_000,
            assetId: 'port',
            transitionIn: { type: 'fade', duration: 300_000 },
          },
        ]),
      },
    ])
    const { result } = await exportProject(project, { encoder: 'cpu' })
    expect(result.duration).toBe(2_800_000)
    expectDuration(await probe(result.file), 2.8)
  })

  it('applies every effect and stays within the clip timing', async () => {
    const effects = [
      'shake',
      'zoomPulse',
      'rgbSplit',
      'flash',
      'blurIn',
      'vhs',
      'glow',
      'beatZoom',
      'strobe',
      'filmGrain',
    ]
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips(
          effects.map((e, i) => ({
            duration: 500_000,
            in: i * 100_000,
            effects: [{ id: `fx${i}`, ref: `testpack/${e}`, start: 0, intensity: 0.8 }],
          })),
        ),
      },
    ])
    const { result } = await exportProject(project)
    expect(result.duration).toBe(5_000_000)
    expectDuration(await probe(result.file), 5)
  })

  it('grades with pack LUTs at full and partial intensity (baked mix)', async () => {
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips([
          { duration: 1_000_000, assetId: 'solid' },
          {
            duration: 1_000_000,
            assetId: 'solid',
            filter: { ref: 'testpack/invert', intensity: 1 },
          },
          {
            duration: 1_000_000,
            assetId: 'solid',
            filter: { ref: 'testpack/invert', intensity: 0.5 },
          },
          // Unsafe manifest path: ignored, renders ungraded.
          {
            duration: 1_000_000,
            assetId: 'solid',
            filter: { ref: 'testpack/escape', intensity: 1 },
          },
        ]),
      },
    ])
    const { result } = await exportProject(project)
    const [orig, inv, half, escaped] = (await Promise.all(
      [0.5, 1.5, 2.5, 3.5].map(async (t) => meanRgb(await frameAt(result.file, t))),
    )) as [Rgb, Rgb, Rgb, Rgb]
    // 0x3060A0 = (48, 96, 160); the untagged fixture was encoded with the BT.601 matrix, so
    // allow for matrix drift against the BT.709-tagged output.
    expect(Math.abs(orig[0] - 48)).toBeLessThan(15)
    expect(Math.abs(orig[2] - 160)).toBeLessThan(15)
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(inv[c]! - (255 - orig[c]!))).toBeLessThan(12)
      expect(Math.abs(half[c]! - (orig[c]! + inv[c]!) / 2)).toBeLessThan(12)
      expect(Math.abs(escaped[c]! - orig[c]!)).toBeLessThan(6)
    }
    // The baked cube is cached under tmp/luts.
    expect((await readdir(path.join(env.paths.tmp, 'luts'))).some((f) => f.endsWith('.cube'))).toBe(
      true,
    )
  })

  it('handles speed 0.5 / 2 / 4 and reverse playback', async () => {
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips([
          { duration: 2_000_000, assetId: 'ramp', speed: 0.5 },
          { duration: 1_000_000, assetId: 'ramp', speed: 2 },
          { duration: 1_000_000, assetId: 'ramp', speed: 4 },
          { duration: 2_000_000, assetId: 'ramp', in: 1_000_000, reverse: true },
          { duration: 1_000_000, assetId: 'land', speed: 2, audio: { preservePitch: false } },
        ]),
      },
    ])
    const { result } = await exportProject(project, { quality: 'high' })
    expectDuration(await probe(result.file), 7)
    const luma = async (t: number) => meanRgb(await frameAt(result.file, t))[0]
    // speed 0.5: 2 s of output show source 0..1 s (dark → 25 %).
    const a0 = await luma(0.1)
    const a1 = await luma(1.9)
    expect(a1).toBeGreaterThan(a0)
    expect(a1).toBeLessThan(90)
    // reverse of source 1..3 s: brightness decreases over the clip.
    const r0 = await luma(4.1)
    const r1 = await luma(5.9)
    expect(r0).toBeGreaterThan(r1 + 60)
  })

  it('animates keyframed zoom, rotation and opacity', async () => {
    const project = makeProject(
      [
        {
          kind: 'main',
          clips: mainClips([
            {
              duration: 2_000_000,
              transform: {
                scale: {
                  value: 1,
                  keyframes: [
                    { t: 0, value: 1 },
                    { t: 2_000_000, value: 2, easing: 'easeOutBack' },
                  ],
                },
                rotation: {
                  value: 0,
                  keyframes: [
                    { t: 0, value: 0 },
                    { t: 1_000_000, value: 15, easing: 'hold' },
                  ],
                },
              },
            },
            {
              duration: 1_000_000,
              assetId: 'solid',
              transform: {
                opacity: {
                  value: 1,
                  keyframes: [
                    { t: 0, value: 0 },
                    { t: 1_000_000, value: 1, easing: 'linear' },
                  ],
                },
              },
            },
          ]),
        },
      ],
      { settings: { background: '#FF0000' } },
    )
    const { result } = await exportProject(project)
    expectDuration(await probe(result.file), 3)
    const f0 = await frameAt(result.file, 0.05)
    const f1 = await frameAt(result.file, 1.95)
    const diff =
      Math.abs(meanRgb(f0)[0] - meanRgb(f1)[0]) + Math.abs(meanRgb(f0)[1] - meanRgb(f1)[1])
    expect(diff).toBeGreaterThan(3)
    // Opacity fade-in over the red background: red first, blue later.
    const early = meanRgb(await frameAt(result.file, 2.05))
    const late = meanRgb(await frameAt(result.file, 2.95))
    expect(early[0]).toBeGreaterThan(late[0] + 80)
    expect(late[2]).toBeGreaterThan(early[2] + 60)
  })

  it('composites overlays, blend modes and pack stickers', async () => {
    const project = makeProject([
      { kind: 'main', clips: mainClips([{ duration: 3_000_000, assetId: 'solid' }]) },
      {
        kind: 'overlay',
        clips: [
          {
            id: 'pip',
            type: 'video',
            assetId: 'land',
            start: 500_000,
            duration: 1_000_000,
            blendMode: 'screen',
            transform: {
              scale: { value: 0.4, keyframes: [] },
              x: {
                value: 540,
                keyframes: [
                  { t: 0, value: 300 },
                  { t: 1_000_000, value: 780 },
                ],
              },
            },
          },
          {
            id: 'logoClip',
            type: 'image',
            assetId: 'logo',
            start: 1_500_000,
            duration: 1_500_000,
            fit: 'contain',
            transform: { scale: { value: 0.5, keyframes: [] } },
          },
        ],
      },
      {
        kind: 'overlay',
        clips: [
          {
            id: 'st',
            type: 'sticker',
            ref: 'testpack/logo',
            start: 0,
            duration: 2_000_000,
            transform: { x: { value: 540, keyframes: [] }, y: { value: 300, keyframes: [] } },
            animationIn: { ref: 'testpack/popIn', duration: 500_000 },
          },
        ],
      },
    ])
    const { result } = await exportProject(project)
    expectDuration(await probe(result.file), 3)
    // The white centre of the logo PNG is composited at the canvas centre; transparent
    // surroundings keep the blue background.
    const f = await frameAt(result.file, 2.5)
    const centre = meanRgb(f, { x0: 0.48, y0: 0.48, x1: 0.52, y1: 0.52 })
    expect(Math.min(...centre)).toBeGreaterThan(200)
    const edge = meanRgb(f, { x0: 0.05, y0: 0.7, x1: 0.2, y1: 0.8 })
    expect(edge[2]).toBeGreaterThan(130)
    expect(edge[0]).toBeLessThan(80)
    // The sticker (white square on transparency) is near the top at 1 s.
    const s = meanRgb(await frameAt(result.file, 1), { x0: 0.47, y0: 0.14, x1: 0.53, y1: 0.17 })
    expect(Math.min(...s)).toBeGreaterThan(200)
  })

  it('burns in text/captions from the ASS document', async () => {
    const project = makeProject([
      { kind: 'main', clips: mainClips([{ duration: 2_000_000, assetId: 'solid' }]) },
      textTrack,
    ])
    const { result } = await exportProject(project, {}, assDeps(boxAss()))
    const f = await frameAt(result.file, 1)
    expect(Math.min(...meanRgb(f, BOX))).toBeGreaterThan(230)
    expect(meanRgb(f, { x0: 0.05, y0: 0.05, x1: 0.2, y1: 0.2 })[2]).toBeGreaterThan(130)
  })

  it('renders real text with the pack fonts through the flat fontsdir', async () => {
    const render = async (fontFamily: string) => {
      const project = makeProject([
        { kind: 'main', clips: mainClips([{ duration: 1_000_000, assetId: 'solid' }]) },
        {
          kind: 'text',
          clips: [
            {
              id: 'txt',
              type: 'text',
              text: 'REELS',
              start: 0,
              duration: 1_000_000,
              style: { fontFamily, fontSize: 260, strokeWidth: 0, shadowY: 0 },
            },
          ],
        },
      ])
      const { result } = await exportProject(project, { encoder: 'cpu' })
      return frameAt(result.file, 0.5, 270, 480)
    }
    /** Fraction of near-white (glyph) pixels per column, i.e. the text's horizontal profile. */
    const profile = (f: { w: number; h: number; data: Buffer }): number[] => {
      const cols = Array.from({ length: f.w }, () => 0)
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          const i = (y * f.w + x) * 3
          if (f.data[i]! > 220 && f.data[i + 1]! > 220 && f.data[i + 2]! > 220) cols[x]! += 1 / f.h
        }
      }
      return cols
    }
    const bebas = profile(await render('Bebas Neue'))
    const pacifico = profile(await render('Pacifico'))
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
    // White glyphs are drawn over the (non-white) solid background…
    expect(sum(bebas)).toBeGreaterThan(1)
    expect(sum(pacifico)).toBeGreaterThan(1)
    // …and the two families rasterise differently (both resolved from the pack, not one fallback).
    const diff = bebas.reduce((acc, v, i) => acc + Math.abs(v - pacifico[i]!), 0)
    expect(diff).toBeGreaterThan(0.2 * Math.max(sum(bebas), sum(pacifico)))
    const flat = await readdir(path.join(env.paths.root, 'fonts-flat'), { recursive: true })
    expect(flat.some((f) => f.endsWith('BebasNeue-Regular.ttf'))).toBe(true)
  })

  it('exports a range with text kept on timeline time', async () => {
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips([
          { duration: 3_000_000, assetId: 'solid' },
          { duration: 2_000_000, assetId: 'land' },
        ]),
      },
      textTrack,
    ])
    const { result } = await exportProject(
      project,
      { range: { start: 1_500_000, end: 3_500_000 } },
      assDeps(boxAss('0:00:02.00', '0:00:02.50')),
    )
    const p = await probe(result.file)
    expectDuration(p, 2)
    // Box visible at timeline 2.0..2.5 → output 0.5..1.0 only.
    expect(Math.min(...meanRgb(await frameAt(result.file, 0.75), BOX))).toBeGreaterThan(230)
    expect(Math.min(...meanRgb(await frameAt(result.file, 0.25), BOX))).toBeLessThan(200)
    expect(Math.min(...meanRgb(await frameAt(result.file, 1.25), BOX))).toBeLessThan(200)
  })

  it('mixes audio tracks with ducking, fades, denoise and voice enhance; silent projects get a silent track', async () => {
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips([
          { duration: 2_000_000, audio: { denoise: true, enhanceVoice: true, fadeIn: 300_000 } },
          { duration: 2_000_000, assetId: 'port', audio: { muted: true } },
        ]),
      },
      {
        kind: 'audio',
        clips: [
          {
            id: 'mus',
            type: 'audio',
            assetId: 'music',
            start: 0,
            duration: 4_000_000,
            duckUnderVoice: true,
            audio: { fadeOut: 1_000_000 },
          },
        ],
      },
      {
        kind: 'audio',
        clips: [
          {
            id: 'vo',
            type: 'audio',
            assetId: 'voice',
            start: 1_000_000,
            duration: 2_000_000,
            role: 'voiceover',
            in: 500_000,
            speed: 1.5,
          },
        ],
      },
    ])
    const { result } = await exportProject(project, { normalizeLoudness: false })
    expectDuration(await probe(result.file), 4)

    const silent = makeProject([
      {
        kind: 'main',
        clips: mainClips([
          { duration: 1_000_000, type: 'image', assetId: 'img' },
          { duration: 1_000_000, assetId: 'silent' },
        ]),
      },
    ])
    const out = await exportProject(silent)
    expectDuration(await probe(out.result.file), 2)
    expect(await integratedLoudness(out.result.file)).toBeLessThan(-60)
  })

  it('tone-maps HDR (HLG) sources to SDR BT.709', async () => {
    const project = makeProject([
      { kind: 'main', clips: mainClips([{ duration: 1_000_000, assetId: 'hdr' }]) },
    ])
    const { result } = await exportProject(project)
    const p = await probe(result.file)
    expect(videoStream(p)).toMatchObject({ pix_fmt: 'yuv420p', color_transfer: 'bt709' })
    const rgb = meanRgb(await frameAt(result.file, 0.5))
    // A tone-mapped testsrc2 is neither black nor clipped white.
    expect(Math.max(...rgb)).toBeGreaterThan(30)
    expect(Math.min(...rgb)).toBeLessThan(230)
  })

  it('decodes HEVC on the GPU (d3d11va) with the same picture as software', async ({ skip }) => {
    if (process.platform !== 'win32') skip('d3d11va is Windows-only')
    const project = makeProject([
      { kind: 'main', clips: mainClips([{ duration: 1_000_000, assetId: 'hdr' }]) },
    ])
    const soft = meanRgb(await frameAt((await exportProject(project)).result.file, 0.5))
    env.tools.hwDecode = 'd3d11va'
    try {
      const { result, job } = await exportProject(makeProject(project.tracks))
      expect(job.warnings).toEqual([])
      const hard = meanRgb(await frameAt(result.file, 0.5))
      for (let c = 0; c < 3; c++) expect(Math.abs(hard[c]! - soft[c]!)).toBeLessThan(3)
    } finally {
      delete env.tools.hwDecode
    }
  })

  it('encodes HEVC (hvc1) and AV1 on the CPU', async () => {
    const project = makeProject([{ kind: 'main', clips: mainClips([{ duration: 1_000_000 }]) }])
    const hevc = await exportProject(project, { codec: 'hevc', encoder: 'cpu' })
    expect(videoStream(await probe(hevc.result.file))).toMatchObject({
      codec_name: 'hevc',
      codec_tag_string: 'hvc1',
    })
    const av1 = await exportProject(project, { codec: 'av1', encoder: 'cpu' })
    expect(videoStream(await probe(av1.result.file))).toMatchObject({ codec_name: 'av1' })
  })

  it('uses the GPU encoder when available', async ({ skip }) => {
    if (!hw) skip('no hardware H.264 encoder on this machine')
    const project = makeProject([{ kind: 'main', clips: mainClips([{ duration: 2_000_000 }]) }])
    const { result } = await exportProject(project, {
      encoder: 'auto',
      resolution: '1080p',
      quality: 'high',
    })
    expect(result.encoder).toBe(hw)
    expect(result.fallbackUsed).toBe(false)
    const v = videoStream(await probe(result.file))
    expect(v).toMatchObject({
      codec_name: 'h264',
      profile: 'High',
      width: 1080,
      height: 1920,
      pix_fmt: 'yuv420p',
    })
  })

  it('falls back to the CPU when the GPU encoder fails', async () => {
    const saved = env.tools.hwEncoders
    env.tools.hwEncoders = { h264: 'bogus_amf' }
    try {
      const project = makeProject([{ kind: 'main', clips: mainClips([{ duration: 1_000_000 }]) }])
      const { result, job } = await exportProject(project, { encoder: 'gpu' })
      expect(result.encoder).toBe('libx264')
      expect(result.fallbackUsed).toBe(true)
      expect(result.fallbackReason).toMatch(/ffmpeg failed/)
      expect(job.warnings.length).toBeGreaterThan(0)
      expectDuration(await probe(result.file), 1)
    } finally {
      env.tools.hwEncoders = saved
    }
  })

  it('renders a 540×960 preview of a range', async () => {
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips([
          { duration: 2_000_000 },
          {
            duration: 2_000_000,
            assetId: 'port',
            transitionIn: { type: 'whip', duration: 400_000 },
          },
        ]),
      },
    ])
    env.store.projects.set(project.id, project)
    const job = fakeJob<PreviewPayload>(env, 'preview', {
      projectId: project.id,
      start: 1_000_000,
      end: 2_500_000,
    })
    const result = await runPreview(job.ctx)
    expect(result.file.endsWith(`${job.ctx.job.id}.mp4`)).toBe(true)
    const p = await probe(result.file)
    expect(videoStream(p)).toMatchObject({ width: 540, height: 960 })
    expectDuration(p, 1.5)
  })

  it('cancels mid-render without leaving partial output', async () => {
    const project = makeProject([
      {
        kind: 'main',
        clips: mainClips(
          Array.from({ length: 6 }, () => ({
            duration: 5_000_000,
            speed: 0.5,
            effects: [{ id: 'g', ref: 'testpack/glow', start: 0 }],
          })),
        ),
      },
    ])
    env.store.projects.set(project.id, project)
    const job = fakeJob<ExportPayload>(env, 'export', {
      projectId: project.id,
      settings: {
        resolution: '1080p',
        quality: 'max',
        encoder: 'cpu',
        normalizeLoudness: false,
      } as ExportPayload['settings'],
    })
    const progress = job.ctx.progress.bind(job.ctx)
    job.ctx.progress = (p, m, e) => {
      progress(p, m, e)
      if (m?.startsWith('Encoding') && p > 0.02)
        job.controller.abort(new Error('cancelled by test'))
    }
    await expect(runExport(job.ctx)).rejects.toThrow(/cancelled/)
    const left = (await readdir(env.paths.exports)).filter((f) => f.startsWith(job.ctx.job.id))
    expect(left).toEqual([])
    expect(existsSync(path.join(env.paths.tmp, `render-${job.ctx.job.id}`))).toBe(false)
  })

  it('fails clearly when a referenced asset is missing', async () => {
    const project = makeProject([
      { kind: 'main', clips: mainClips([{ duration: 1_000_000, assetId: 'nope' }]) },
    ])
    await expect(exportProject(project)).rejects.toThrow(/asset nope/)
  })
})
