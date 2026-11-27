/**
 * `matte` job with the real MODNet model: a public-domain NASA portrait (Neil Armstrong, 1969)
 * placed on a dark 1280x720 video and as a still. The matte must be opaque on the face and
 * transparent on the empty background; throughput is reported. Gated on FFmpeg and the model
 * (`pnpm bootstrap`) and, for the portrait, network access on first run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { download } from '../../../../scripts/lib/download.ts'
import { matteFile, matteJob, matteProxyFile, type MatteResult } from '../../src/ai/matte/index.ts'
import { matteModelPath } from '../../src/ai/matte/models.ts'
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

const tmp = makeTempDir('matte')
const paths = makePaths(tmp.dir)
const MODEL = matteModelPath(paths, 'modnet')
const FACE_URL = 'https://upload.wikimedia.org/wikipedia/commons/0/0d/Neil_Armstrong_pose.jpg'
const FACE_SHA256 = '2acf38e1ed3f9502daedb95cecdd4f69f1626f62241e4ce42a2ba3979b93dee0'

const skipReason =
  NO_FFMPEG || (!existsSync(MODEL) && `matting model missing at ${MODEL} - run pnpm bootstrap`)

/** Gray frame `t` seconds into `file`, scaled to w x h bytes. */
const grayFrame = (file: string, t: number, w: number, h: number): Uint8Array =>
  new Uint8Array(
    execFileSync(
      FFMPEG_BIN,
      [
        '-v',
        'error',
        '-ss',
        String(t),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `scale=${w}:${h}`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        'pipe:1',
      ],
      { maxBuffer: 1 << 26 },
    ),
  )

const mean = (f: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): number => {
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      s += f[y * w + x] ?? 0
      n++
    }
  return s / n
}

describe.skipIf(skipBecause(skipReason))('matte job (real MODNet)', () => {
  const store = new MemoryStore()
  let portrait: string | undefined
  let fetchError = ''
  afterAll(() => tmp.cleanup())

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

  /** 320x400 portrait centred on a 1280x720 dark frame. */
  const makeScene = (out: string, seconds: number): void => {
    const small = path.join(tmp.dir, 'portrait.png')
    ffmpeg(['-i', portrait!, '-vf', 'scale=320:400', small])
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `color=c=0x101820:size=1280x720:rate=30:duration=${seconds}`,
      '-loop',
      '1',
      '-i',
      small,
      '-filter_complex',
      '[0:v][1:v]overlay=x=480:y=160:shortest=1,format=yuv420p',
      '-t',
      String(seconds),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      out,
    ])
  }

  it(
    'mattes a video: opaque subject, transparent background, cached, files written',
    { timeout: 300_000 },
    async (t) => {
      if (!portrait) {
        console.warn(`[skip] public-domain portrait unavailable (${fetchError})`)
        t.skip()
        return
      }
      const file = path.join(tmp.dir, 'scene.mp4')
      makeScene(file, 3)
      addAssetFile(
        paths,
        store,
        makeAsset('scene', 'scene.mp4', { duration: 3_000_000, width: 1280, height: 720, fps: 30 }),
        file,
      )
      const ctx = makeContext('matte', { assetId: 'scene' }, paths, store)
      const started = performance.now()
      const r = (await matteJob.handler(ctx)) as MatteResult
      const ms = performance.now() - started
      console.warn(
        `[bench] matte: ${r.frames} frames in ${ms.toFixed(0)} ms (${((r.frames * 1000) / ms).toFixed(1)} fps end to end, ${r.fpsProcessed} fps in-loop, ${r.provider}, ${r.width}x${r.height}), rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB`,
      )
      expect(r.cached).toBe(false)
      expect(r.frames).toBeGreaterThanOrEqual(88)
      expect(r.model).toBe('modnet')
      const asset = store.getAsset('scene')!
      expect(asset.matte).toMatchObject({ status: 'ready', model: 'modnet', version: 1 })
      expect(existsSync(matteFile(paths, 'scene'))).toBe(true)
      expect(existsSync(matteProxyFile(paths, asset))).toBe(true)
      // face near x 640, y 260 (portrait is 320x400 at 480,160; the face sits in its upper half)
      const w = 320
      const h = 180
      for (const sec of [0.5, 2.5]) {
        const f = grayFrame(matteFile(paths, 'scene'), sec, w, h)
        expect(mean(f, w, 164, 62, 174, 70)).toBeGreaterThan(200)
        expect(mean(f, w, 0, 0, 80, 40)).toBeLessThan(25)
        expect(mean(f, w, 240, 120, 320, 180)).toBeLessThan(25)
      }
      // the preview proxy decodes and agrees
      const p = grayFrame(matteProxyFile(paths, asset), 1, w, h)
      expect(mean(p, w, 164, 62, 174, 70)).toBeGreaterThan(190)
      expect(mean(p, w, 0, 0, 80, 40)).toBeLessThan(30)
      expect(ctx.progressLog.at(-1)?.p).toBe(1)

      // second run: cache hit, no recompute
      const again = (await matteJob.handler(
        makeContext('matte', { assetId: 'scene' }, paths, store),
      )) as MatteResult
      expect(again.cached).toBe(true)
      expect(store.getAsset('scene')?.matte?.version).toBe(1)
      // force: recomputes and bumps the version
      const forced = (await matteJob.handler(
        makeContext('matte', { assetId: 'scene', force: true }, paths, store),
      )) as MatteResult
      expect(forced.cached).toBe(false)
      expect(store.getAsset('scene')?.matte?.version).toBe(2)
    },
  )

  it('mattes a still image into a PNG proxy', { timeout: 120_000 }, async (t) => {
    if (!portrait) {
      t.skip()
      return
    }
    const still = path.join(tmp.dir, 'still.png')
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x101820:size=1280x720',
      '-i',
      portrait,
      '-filter_complex',
      '[1:v]scale=320:400[p];[0:v][p]overlay=x=480:y=160',
      '-frames:v',
      '1',
      still,
    ])
    addAssetFile(
      paths,
      store,
      makeAsset('still', 'still.png', {
        kind: 'image',
        mime: 'image/png',
        hasAudio: false,
        width: 1280,
        height: 720,
      }),
      still,
    )
    const r = (await matteJob.handler(
      makeContext('matte', { assetId: 'still' }, paths, store),
    )) as MatteResult
    expect(r.frames).toBe(1)
    const asset = store.getAsset('still')!
    const proxy = matteProxyFile(paths, asset)
    expect(proxy.endsWith('.png')).toBe(true)
    const f = grayFrame(proxy, 0, 320, 180)
    expect(mean(f, 320, 164, 62, 174, 70)).toBeGreaterThan(200)
    expect(mean(f, 320, 0, 0, 80, 40)).toBeLessThan(25)
  })

  it('cancels promptly and leaves no partial matte', { timeout: 120_000 }, async (t) => {
    if (!portrait) {
      t.skip()
      return
    }
    const long = path.join(tmp.dir, 'long.mp4')
    makeScene(long, 30)
    addAssetFile(
      paths,
      store,
      makeAsset('long', 'long.mp4', { duration: 30_000_000, width: 1280, height: 720, fps: 30 }),
      long,
    )
    const ac = new AbortController()
    const ctx = makeContext('matte', { assetId: 'long' }, paths, store, {}, ac.signal)
    setTimeout(() => ac.abort(), 2500)
    await expect(matteJob.handler(ctx)).rejects.toThrow(/cancel/i)
    expect(existsSync(matteFile(paths, 'long'))).toBe(false)
    expect(store.getAsset('long')?.matte).toBeUndefined()
  })

  it('rejects audio assets and a bad payload', async () => {
    const wav = path.join(tmp.dir, 'a.wav')
    ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=1', wav])
    addAssetFile(paths, store, makeAsset('aud', 'a.wav', { kind: 'audio', hasVideo: false }), wav)
    await expect(
      matteJob.handler(makeContext('matte', { assetId: 'aud' }, paths, store)),
    ).rejects.toThrow(/video or image/)
    await expect(
      matteJob.handler(makeContext('matte', { assetId: 'x', model: 'nope' }, paths, store)),
    ).rejects.toThrow(/invalid payload/)
  })
})
