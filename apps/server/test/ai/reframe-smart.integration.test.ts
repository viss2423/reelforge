/**
 * Smart reframe end to end on generated video: FFmpeg frames -> D-FINE / YuNet / U2-Netp ->
 * planner. Gated on FFmpeg and the object model (`models/objects/`, from `pnpm bootstrap`).
 * The scene is synthetic (no people), so it checks the machinery and the fast fallback; the
 * person-tracking quality is measured on real footage in the README benchmark.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeReframe, findReframeModels, reframeJob } from '../../src/ai/reframe/index.ts'
import { releaseIdleSessions } from '../../src/ai/onnx.ts'
import {
  addAssetFile,
  ffmpeg,
  FFMPEG_BIN,
  makeAsset,
  makeContext,
  makePaths,
  makeTempDir,
  MemoryStore,
  NO_FFMPEG,
  skipBecause,
} from './helpers.ts'

const tmp = makeTempDir('reframe-smart')
const paths = makePaths(tmp.dir)
const models = findReframeModels(paths)
afterAll(() => {
  releaseIdleSessions()
  tmp.cleanup()
})

describe('findReframeModels', () => {
  it('needs the face model; object and saliency models are optional', () => {
    expect(findReframeModels({ ...paths, models: path.join(tmp.dir, 'none') })).toBeUndefined()
  })
})

describe.skipIf(
  skipBecause(
    NO_FFMPEG ||
      (!models?.objects && 'object model missing (run `pnpm bootstrap`)') ||
      (!existsSync(models?.face ?? '') && 'face model missing'),
  ),
)('smart reframe (real models)', () => {
  const clip = path.join(tmp.dir, 'blob.mp4')
  const makeClip = (): void => {
    // A bright disc crossing a dark noisy background, with a 440 Hz tone.
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x202830:s=640x360:r=10:d=6',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=6',
      '-filter_complex',
      "[0]geq=lum='128+60*sin(X/9)':cb=128:cr=128,drawbox=x='40+90*t':y=120:w=120:h=120:c=white:t=fill[v]",
      '-map',
      '[v]',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      clip,
    ])
  }

  it(
    'returns a valid smart path with a mode, framing counts and throughput',
    { timeout: 180_000 },
    async () => {
      makeClip()
      const r = await analyzeReframe({
        ffmpeg: FFMPEG_BIN,
        file: clip,
        model: models!.face,
        models: models!,
        channels: 1,
      })
      expect(r.mode).toBe('smart')
      expect(r.analysisFps).toBeGreaterThan(0)
      expect(r.path.length).toBeGreaterThan(0)
      for (const p of r.path) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(1)
      }
      const total = Object.values(r.framing ?? {}).reduce((a, b) => a + b, 0)
      expect(total).toBeGreaterThanOrEqual(15)
    },
  )

  it('mode: fast keeps the original YuNet path', { timeout: 120_000 }, async () => {
    makeClip()
    const r = await analyzeReframe({
      ffmpeg: FFMPEG_BIN,
      file: clip,
      model: models!.face,
      models: models!,
      mode: 'fast',
    })
    expect(r.mode).toBe('fast')
    expect(r.framing).toBeUndefined()
  })

  it(
    'the job honours mode and strength and reports the subject count',
    { timeout: 180_000 },
    async () => {
      makeClip()
      const store = new MemoryStore()
      const asset = makeAsset('r1', 'blob.mp4', { duration: 6_000_000 })
      addAssetFile(paths, store, asset, clip)
      const ctx = makeContext(
        'reframe',
        { assetId: 'r1', strength: 0.9, mode: 'smart' },
        paths,
        store,
      )
      const r = (await reframeJob.handler(ctx)) as { mode: string; path: unknown[] }
      expect(r.mode).toBe('smart')
      expect(r.path.length).toBeGreaterThan(0)
      expect(ctx.progressLog.at(-1)?.p).toBe(1)
      await expect(
        reframeJob.handler(makeContext('reframe', { assetId: 'r1', strength: 3 }, paths, store)),
      ).rejects.toThrow(/invalid payload/)
    },
  )
})
