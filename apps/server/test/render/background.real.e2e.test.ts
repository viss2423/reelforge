/**
 * Real model → real export: the `matte` job runs MODNet on a public-domain NASA portrait
 * (Neil Armstrong, 1969) placed on a dark landscape video, then the export job replaces the
 * background with red / removes it / puts text behind him. Pixel statistics prove the face is
 * kept and the empty background replaced. Gated on FFmpeg, the model (`pnpm bootstrap`) and,
 * on first run, network access for the portrait.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '@reelforge/core'
import { download } from '../../../../scripts/lib/download.ts'
import { matteJob } from '../../src/ai/matte/index.ts'
import { matteModelPath } from '../../src/ai/matte/models.ts'
import type { ExportPayload } from '../../src/contracts.ts'
import { runExport } from '../../src/render/index.ts'
import type { RenderDeps } from '../../src/render/pipeline.ts'
import { assetFile } from '../../src/paths.ts'
import {
  addFixture,
  createEnv,
  fakeJob,
  ffmpegAvailable,
  frameAt,
  mainClips,
  makeProject,
  meanRgb,
  type Env,
} from './harness.ts'

const DATA = process.env.REELFORGE_DATA ?? path.join(os.homedir(), '.reelforge')
const MODEL_SRC = path.join(DATA, 'models', 'matte', 'modnet.onnx')
const FACE_URL = 'https://upload.wikimedia.org/wikipedia/commons/0/0d/Neil_Armstrong_pose.jpg'
const FACE_SHA256 = '2acf38e1ed3f9502daedb95cecdd4f69f1626f62241e4ce42a2ba3979b93dee0'

const skip = !ffmpegAvailable()
  ? 'ffmpeg not available'
  : !existsSync(MODEL_SRC)
    ? `matting model missing at ${MODEL_SRC} - run pnpm bootstrap`
    : undefined
if (skip) console.warn(`[skip] real matte export tests: ${skip}`)

const HEAD = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
`

type Rgb = [number, number, number]
const dist = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * Where things land in the 9:16 export: the 1280×720 scene is cover-cropped to x 437..842, so
 * the face (scene x 675, y 255) is at canvas (0.59, 0.354) and the top-left corner is the
 * empty dark backdrop.
 */
const FACE = { x0: 0.56, y0: 0.32, x1: 0.62, y1: 0.39 }
const BACKDROP = { x0: 0.02, y0: 0.02, x1: 0.2, y1: 0.1 }
/** Suit torso, inside the subject. */
const TORSO = { x0: 0.6, y0: 0.55, x1: 0.8, y1: 0.7 }

describe.skipIf(!!skip)('real MODNet matte → export', () => {
  let env: Env
  let portrait: string | undefined
  let fetchError = ''

  beforeAll(async () => {
    try {
      portrait = (
        await download({
          url: FACE_URL,
          dest: path.join(os.tmpdir(), 'reelforge-test-cache', 'armstrong.jpg'),
          sha256: FACE_SHA256,
          retries: 1,
          quiet: true,
        })
      ).path
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err)
      return
    }
    env = await createEnv()
    const dest = matteModelPath(env.paths, 'modnet')
    mkdirSync(path.dirname(dest), { recursive: true })
    copyFileSync(MODEL_SRC, dest)
    await addFixture(env, {
      id: 'face',
      kind: 'video',
      name: 'face.mp4',
      args: [
        '-f',
        'lavfi',
        '-i',
        'color=c=0x101820:size=1280x720:rate=30:duration=3',
        '-loop',
        '1',
        '-i',
        portrait,
        '-filter_complex',
        '[1:v]scale=320:400[p];[0:v][p]overlay=x=480:y=160:shortest=1,format=yuv420p',
        '-t',
        '3',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
      ],
      meta: { width: 1280, height: 720, fps: 30, duration: 3_000_000, hasVideo: true },
    })
    const job = fakeJob(env, 'matte', { assetId: 'face' })
    await matteJob.handler(job.ctx)
  }, 300_000)

  afterAll(async () => {
    await env?.dispose()
  })

  const frame = async (
    clip: Record<string, unknown>,
    opts: { text?: boolean } = {},
  ): Promise<Awaited<ReturnType<typeof frameAt>>> => {
    const project: Project = makeProject(
      [
        { kind: 'main', clips: mainClips([{ duration: 1_000_000, assetId: 'face', ...clip }]) },
        ...(opts.text
          ? [
              {
                kind: 'text' as const,
                clips: [
                  {
                    id: 'tx',
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
      { settings: { background: '#0000ff' } },
    )
    env.store.projects.set(project.id, project)
    const job = fakeJob<ExportPayload>(env, 'export', {
      projectId: project.id,
      settings: { resolution: '720p', quality: 'draft' } as ExportPayload['settings'],
    })
    const deps: RenderDeps = {
      // a white 600×300 block over the face region (canvas px), behind the subject
      buildAss: (_p, ctx) =>
        ctx.layer === 'front'
          ? `${HEAD}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
          : `${HEAD}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:30.00,Default,,0,0,0,,{\\pos(540,560)\\p1}m 0 0 l 400 0 400 300 0 300{\\p0}\n`,
    }
    const { file } = (await runExport(job.ctx, deps)) as { file: string }
    return frameAt(file, 0.4, 108, 192)
  }

  const need = (t: { skip: () => void }): boolean => {
    if (portrait) return true
    console.warn(`[skip] public-domain portrait unavailable (${fetchError})`)
    t.skip()
    return false
  }

  it('the matte job wrote the cache files for the asset', (t) => {
    if (!need(t)) return
    expect(env.store.getAsset('face')?.matte?.status).toBe('ready')
    expect(
      existsSync(
        path.join(
          path.dirname(assetFile(env.paths, { id: 'face', name: 'face.mp4' }, 'original')),
          'matte.mkv',
        ),
      ),
    ).toBe(true)
  })

  it(
    'colour: the face and suit stay, the empty backdrop becomes red',
    { timeout: 120_000 },
    async (t) => {
      if (!need(t)) return
      const [ref, out] = await Promise.all([
        frame({}),
        frame({ background: { mode: 'color', color: '#ff0000' } }),
      ])
      expect(dist(meanRgb(out, FACE), meanRgb(ref, FACE))).toBeLessThan(25)
      expect(dist(meanRgb(out, TORSO), meanRgb(ref, TORSO))).toBeLessThan(25)
      expect(dist(meanRgb(out, BACKDROP), [255, 0, 0])).toBeLessThan(60)
      expect(dist(meanRgb(ref, BACKDROP), [255, 0, 0])).toBeGreaterThan(150)
    },
  )

  it('remove: the backdrop shows the project background', { timeout: 120_000 }, async (t) => {
    if (!need(t)) return
    const out = await frame({ background: { mode: 'remove' } })
    expect(dist(meanRgb(out, BACKDROP), [0, 0, 255])).toBeLessThan(60)
    expect(dist(meanRgb(out, FACE), [0, 0, 255])).toBeGreaterThan(150)
  })

  it('text behind subject: the face covers the text block', { timeout: 120_000 }, async (t) => {
    if (!need(t)) return
    const [ref, withText] = await Promise.all([frame({}), frame({}, { text: true })])
    // face unchanged although the white block lies right behind it
    expect(dist(meanRgb(withText, FACE), meanRgb(ref, FACE))).toBeLessThan(25)
    // the block is visible beside the face (on the backdrop / moon)
    expect(
      dist(meanRgb(withText, { x0: 0.72, y0: 0.3, x1: 0.78, y1: 0.33 }), [255, 255, 255]),
    ).toBeLessThan(60)
  })
})
