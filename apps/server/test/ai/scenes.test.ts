import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanCuts,
  detectScenes,
  MIN_SHOT_US,
  parseScdetLine,
  scenesJob,
} from '../../src/ai/scenes.ts'
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

describe('parseScdetLine', () => {
  it('extracts the cut time in us', () => {
    expect(
      parseScdetLine('[Parsed_scdet_1 @ 000001] lavfi.scd.score: 22.564, lavfi.scd.time: 2.002'),
    ).toBe(2_002_000)
    expect(parseScdetLine('lavfi.scd.time: 0')).toBeUndefined()
    expect(parseScdetLine('frame=  100 fps=0.0')).toBeUndefined()
    expect(parseScdetLine('lavfi.scd.time: nan')).toBeUndefined()
  })
})

describe('cleanCuts', () => {
  it('sorts, de-duplicates and drops flashes closer than the minimum shot length', () => {
    expect(cleanCuts([4_000_000, 2_000_000, 2_000_000, 2_100_000, 100_000, 6_000_000])).toEqual([
      2_000_000, 4_000_000, 6_000_000,
    ])
    expect(cleanCuts([], MIN_SHOT_US)).toEqual([])
  })
})

describe.skipIf(skipBecause(NO_FFMPEG))('scene detection (FFmpeg scdet)', () => {
  let tmp: ReturnType<typeof makeTempDir>
  let file: string
  beforeAll(() => {
    tmp = makeTempDir('scenes')
    file = path.join(tmp.dir, 'cuts.mp4')
    const s = 's=640x360:r=25:d=2'
    ffmpeg([
      '-filter_complex',
      `color=c=red:${s}[a];testsrc2=${s}[b];color=c=blue:${s}[c];smptebars=${s}[d];` +
        `mandelbrot=${s.replace('d=2', '')},trim=duration=2[e];[a][b][c][d][e]concat=n=5:v=1:a=0,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '250',
      file,
    ])
  })
  afterAll(() => tmp.cleanup())

  it('finds every cut within one frame', async () => {
    const cuts = await detectScenes({ ffmpeg: FFMPEG_BIN, file })
    const expected = [2, 4, 6, 8]
    expect(cuts).toHaveLength(expected.length)
    cuts.forEach((c, i) =>
      expect(Math.abs(c - (expected[i] ?? 0) * 1e6)).toBeLessThanOrEqual(40_000),
    )
  })

  it('caches cuts on the asset via the job', async () => {
    const paths = makePaths(tmp.dir)
    const store = new MemoryStore()
    addAssetFile(paths, store, makeAsset('v1', 'cuts.mp4', { duration: 10_000_000 }), file)
    const ctx = makeContext('scenes', { assetId: 'v1' }, paths, store)
    const r = (await scenesJob.handler(ctx)) as { scenes: number[] }
    expect(r.scenes).toHaveLength(4)
    expect(store.getAsset('v1')?.scenes).toEqual(r.scenes)
    expect(ctx.events).toHaveLength(1)
    expect(ctx.progressLog.some((p) => p.p > 0 && p.p < 1)).toBe(true)
  })

  it('a high threshold suppresses weak cuts', async () => {
    const cuts = await detectScenes({ ffmpeg: FFMPEG_BIN, file, threshold: 100 })
    expect(cuts).toEqual([])
  })

  it('rejects audio-only assets and honours cancellation', async () => {
    const paths = makePaths(tmp.dir)
    const store = new MemoryStore()
    store.putAsset(makeAsset('a1', 'x.wav', { kind: 'audio' }))
    addAssetFile(paths, store, makeAsset('a1', 'x.wav', { kind: 'audio' }), file)
    await expect(
      scenesJob.handler(makeContext('scenes', { assetId: 'a1' }, paths, store)),
    ).rejects.toThrow(/video/)
    const ac = new AbortController()
    const p = detectScenes({ ffmpeg: FFMPEG_BIN, file, signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow(/cancel/i)
  })
})
