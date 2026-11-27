/**
 * End-to-end auto-reframe: FFmpeg frame sampling → YuNet (onnxruntime-node) → virtual
 * camera, on generated videos. The moving-face case composites a public-domain NASA
 * portrait (Neil Armstrong, 1969 — a work of the U.S. federal government) fetched once into
 * a local cache with a pinned SHA-256. Gated on FFmpeg, the YuNet model and (for the face
 * case) network access on first run.
 */
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { download } from '../../../../scripts/lib/download.ts'
import type { PathPoint } from '../../src/ai/reframe/camera.ts'
import {
  analyzeReframe,
  faceModelPath,
  reframeJob,
  type ReframeResult,
} from '../../src/ai/reframe/index.ts'
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

const tmp = makeTempDir('reframe')
const paths = makePaths(tmp.dir)
const MODEL = faceModelPath(paths)

const FACE_URL = 'https://upload.wikimedia.org/wikipedia/commons/0/0d/Neil_Armstrong_pose.jpg'
const FACE_SHA256 = '2acf38e1ed3f9502daedb95cecdd4f69f1626f62241e4ce42a2ba3979b93dee0'
/** Face centre in the portrait as a fraction of its width (measured on the image). */
const FACE_CX = 0.615

/** Linear interpolation of a (compressed) path at time t. */
const pathAt = (p: readonly PathPoint[], t: number): number => {
  const first = p[0]
  if (!first || t <= first.t) return first?.x ?? 0.5
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]
    const b = p[i]
    if (a && b && t <= b.t) return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t)
  }
  return p.at(-1)?.x ?? 0.5
}

const skipReason =
  NO_FFMPEG || (!existsSync(MODEL) && `face model missing at ${MODEL} — run \`pnpm bootstrap\``)

describe.skipIf(skipBecause(skipReason))('reframe (FFmpeg → YuNet → camera)', () => {
  const store = new MemoryStore()
  afterAll(() => tmp.cleanup())

  it('centres the path when there is no face', { timeout: 60_000 }, async () => {
    const file = path.join(tmp.dir, 'noface.mp4')
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=4',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      file,
    ])
    addAssetFile(
      paths,
      store,
      makeAsset('noface', 'noface.mp4', { duration: 4_000_000, width: 1280, height: 720 }),
      file,
    )
    const ctx = makeContext('reframe', { assetId: 'noface', mode: 'fast' }, paths, store)
    const r = (await reframeJob.handler(ctx)) as ReframeResult
    expect(r.facesFound).toBe(0)
    expect(r.path.length).toBeGreaterThan(0)
    for (const p of r.path) expect(p.x).toBe(0.5)
    expect(r.path[0]?.t).toBe(0)
    expect(ctx.progressLog.at(-1)).toEqual({ p: 1, message: 'No faces — centred' })
  })

  it('rejects non-video assets and missing payload fields', async () => {
    const wav = path.join(tmp.dir, 'a.wav')
    ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=1', wav])
    addAssetFile(paths, store, makeAsset('aud', 'a.wav', { kind: 'audio', hasVideo: false }), wav)
    await expect(
      reframeJob.handler(makeContext('reframe', { assetId: 'aud' }, paths, store)),
    ).rejects.toThrow(/video/)
    await expect(reframeJob.handler(makeContext('reframe', {}, paths, store))).rejects.toThrow(
      /invalid payload/,
    )
  })

  describe('moving face', () => {
    let portrait: string | undefined
    let fetchError = ''
    beforeAll(async () => {
      const cache = path.join(os.tmpdir(), 'reelforge-test-cache')
      try {
        portrait = (
          await download({
            url: FACE_URL,
            dest: path.join(cache, 'armstrong.jpg'),
            sha256: FACE_SHA256,
            retries: 1,
            quiet: true,
          })
        ).path
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err)
      }
    }, 120_000)

    it('follows a face moving left → right', { timeout: 120_000 }, async (t) => {
      if (!portrait) {
        console.warn(`[skip] public-domain face image unavailable (${fetchError})`)
        t.skip()
        return
      }
      // 320×400 portrait slides across a 1280×720 frame in 6 s. Scaling the 3300×4125 JPEG
      // once up front keeps fixture generation well under a second.
      const small = path.join(tmp.dir, 'portrait.png')
      const file = path.join(tmp.dir, 'face.mp4')
      const W = 1280
      const PW = 320
      const seconds = 6
      ffmpeg(['-i', portrait, '-vf', `scale=${PW}:400`, small])
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        `color=c=0x202830:size=${W}x720:rate=30:duration=${seconds}`,
        '-loop',
        '1',
        '-i',
        small,
        '-filter_complex',
        `[0:v][1:v]overlay=x='t/${seconds}*${W - PW}':y=160:shortest=1,format=yuv420p`,
        '-t',
        String(seconds),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        file,
      ])
      const started = performance.now()
      const r = await analyzeReframe({ ffmpeg: FFMPEG_BIN, file, model: MODEL })
      const ms = performance.now() - started
      console.warn(
        `[bench] reframe: ${r.analysisFps} analysed frames/s (${r.provider}), ${seconds}s clip in ${ms.toFixed(0)} ms (${((seconds * 1000) / ms).toFixed(1)}× realtime)`,
      )
      expect(r.facesFound).toBe(1)
      expect(r.coverage).toBeGreaterThan(0.8)
      const expected = (s: number): number => ((s / seconds) * (W - PW) + FACE_CX * PW) / W
      // The camera is smoothed (dead zone + spring) so allow some lag/lead mid-pan.
      for (const s of [1, 2, 3, 4, 5])
        expect(Math.abs(pathAt(r.path, s * 1_000_000) - expected(s))).toBeLessThan(0.1)
      // Monotonic pan, no jitter reversals.
      for (let i = 1; i < r.path.length; i++) {
        expect(r.path[i]?.x ?? 0).toBeGreaterThanOrEqual((r.path[i - 1]?.x ?? 0) - 1e-3)
        expect(r.path[i]?.t ?? 0).toBeGreaterThan(r.path[i - 1]?.t ?? 0)
      }
    })
  })

  it('honours cancellation', { timeout: 60_000 }, async () => {
    const file = path.join(tmp.dir, 'long.mp4')
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30:duration=20',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      file,
    ])
    const ac = new AbortController()
    const p = analyzeReframe({ ffmpeg: FFMPEG_BIN, file, model: MODEL, signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    await expect(p).rejects.toThrow(/cancel/i)
  })
})
