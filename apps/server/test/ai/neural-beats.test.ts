/**
 * Neural beat tracking: pure pieces (mel front end, windowing, peak picking) plus gated
 * real-model runs on synthetic music with exact ground truth. The model is looked up in the
 * data dir (`models/beats/`, from `pnpm bootstrap`); without it the integration block is
 * skipped with a printed reason.
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  analyzeBeats,
  analyzeBeatsNeural,
  beatsJob,
  findBeatModel,
} from '../../src/ai/beats/index.ts'
import { LogMelStream, MEL_BANDS, MEL_FPS, parseFilterbank } from '../../src/ai/beats/mel.ts'
import {
  aggregate,
  BORDER,
  CHUNK,
  deduplicatePeaks,
  inferBeats,
  pickPeaks,
  postprocess,
  splitStarts,
  windowAt,
} from '../../src/ai/beats/neural.ts'
import { releaseIdleSessions } from '../../src/ai/onnx.ts'
import {
  addAssetFile,
  FFMPEG_BIN,
  makeAsset,
  makeContext,
  makePaths,
  makeTempDir,
  MemoryStore,
  NO_FFMPEG,
  rng,
  skipBecause,
} from './helpers.ts'
import { fMeasure, STYLES, synthesize, writeWav } from './music-synth.ts'

describe('mel front end', () => {
  /** Triangular synthetic filterbank (the shape matters here, not the exact values). */
  const fb = new Float32Array(513 * MEL_BANDS)
  for (let m = 0; m < MEL_BANDS; m++) {
    const c = 4 + m * 3.8
    for (let k = 0; k < 513; k++) fb[k * MEL_BANDS + m] = Math.max(0, 1 - Math.abs(k - c) / 6)
  }
  const signal = (n: number): Float32Array => {
    const r = rng(3)
    return Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i * 0.07) + 0.1 * (r() - 0.5))
  }

  it('produces 50 frames per second, centred (1 + floor(n / hop))', () => {
    const s = new LogMelStream(fb)
    s.push(signal(22_050 * 3 + 100))
    expect(s.finish().length / MEL_BANDS).toBe(1 + Math.floor((22_050 * 3 + 100) / 441))
    expect(MEL_FPS).toBeCloseTo(50, 6)
  })

  it('is independent of how the stream is chunked', () => {
    const x = signal(30_000)
    const a = new LogMelStream(fb)
    a.push(x)
    const b = new LogMelStream(fb)
    const r = rng(9)
    for (let i = 0; i < x.length;) {
      const n = 1 + Math.floor(r() * 3000)
      b.push(x.subarray(i, i + n))
      i += n
    }
    expect(Array.from(b.finish())).toEqual(Array.from(a.finish()))
  })

  it('handles empty and very short input and validates the filterbank', () => {
    expect(new LogMelStream(fb).finish().length).toBe(0)
    const s = new LogMelStream(fb)
    s.push(signal(100))
    expect(s.finish().length % MEL_BANDS).toBe(0)
    expect(() => parseFilterbank(new Uint8Array(10))).toThrow(/filterbank/)
    expect(() => new LogMelStream(new Float32Array(5))).toThrow(/size/)
  })

  it('silence maps to zero (log1p(0))', () => {
    const s = new LogMelStream(fb)
    s.push(new Float32Array(10_000))
    expect(Math.max(...s.finish())).toBe(0)
  })
})

describe('windowing and aggregation (reference split_piece / keep_first)', () => {
  it('covers the piece with overlapping windows, the last aligned to the end', () => {
    const frames = 4000
    const starts = splitStarts(frames)
    expect(starts[0]).toBe(-BORDER)
    expect(starts.length).toBe(Math.ceil((frames + BORDER) / (CHUNK - 2 * BORDER)))
    expect(starts.at(-1)).toBe(frames - (CHUNK - BORDER))
    expect(splitStarts(1000)).toEqual([-BORDER])
  })

  it('zero-pads the head of the first window', () => {
    const spect = Float32Array.from({ length: 100 * MEL_BANDS }, (_, i) => i + 1)
    const w = windowAt(spect, 100, -BORDER)
    expect(w.data[0]).toBe(0)
    expect(w.data[BORDER * MEL_BANDS]).toBe(1)
    expect(w.length).toBeGreaterThanOrEqual(100 + BORDER)
  })

  it('aggregate keeps the first window where windows overlap', () => {
    const mk = (start: number, v: number) => ({
      start,
      beat: new Float32Array(20).fill(v),
      downbeat: new Float32Array(20).fill(-v),
    })
    const { beat, downbeat } = aggregate([mk(-2, 1), mk(8, 2)], 24, 2)
    expect(beat[0]).toBe(1)
    expect(beat[15]).toBe(1)
    expect(beat[16]).toBe(2)
    expect(downbeat[16]).toBe(-2)
  })

  it('inferBeats runs every window, concurrently, reports progress and honours abort', async () => {
    const frames = 3500
    const spect = new Float32Array(frames * MEL_BANDS)
    let calls = 0
    const run = async (_w: Float32Array, length: number) => {
      calls++
      const beat = new Float32Array(length).fill(-5)
      for (let i = 0; i < length; i += 25) beat[i] = 4
      return { beat, downbeat: new Float32Array(length).fill(-5) }
    }
    const progress: number[] = []
    const r = await inferBeats(spect, run, { concurrency: 2, onProgress: (f) => progress.push(f) })
    expect(calls).toBe(splitStarts(frames).length)
    expect(progress.at(-1)).toBe(1)
    expect(r.beats.length).toBeGreaterThan(100)
    const abort = new AbortController()
    abort.abort()
    await expect(inferBeats(spect, run, { signal: abort.signal })).rejects.toBeDefined()
    expect((await inferBeats(new Float32Array(10 * MEL_BANDS), run)).beats).toEqual([])
  })
})

describe('peak picking', () => {
  it('keeps maxima above zero within +-3 frames and merges neighbours', () => {
    const l = new Float32Array(40).fill(-4)
    l[10] = 3
    l[12] = 2
    l[20] = 1
    l[21] = 1
    expect(pickPeaks(l)).toEqual([10, 20, 21])
    expect(deduplicatePeaks([10, 20, 21])).toEqual([10, 20.5])
    expect(deduplicatePeaks([])).toEqual([])
  })

  it('postprocess converts frames to us, snaps downbeats to beats and derives BPM', () => {
    const n = 500
    const beat = new Float32Array(n).fill(-5)
    const down = new Float32Array(n).fill(-5)
    for (let i = 25; i < n; i += 25) beat[i] = 3
    for (let i = 26; i < n; i += 100) down[i] = 3
    const r = postprocess(beat, down)
    expect(r.bpm).toBeCloseTo(120, 1)
    expect(r.beats[0]).toBe(500_000)
    expect(r.downbeats[0]).toBe(500_000)
    expect(r.downbeats.every((d) => r.beats.includes(d))).toBe(true)
    expect(postprocess(new Float32Array(10).fill(-5), new Float32Array(10).fill(-5))).toEqual({
      bpm: 0,
      beats: [],
      downbeats: [],
    })
  })
})

const tmp = makeTempDir('neural-beats')
const paths = makePaths(tmp.dir)
const model = findBeatModel(paths)

afterAll(() => {
  releaseIdleSessions()
  tmp.cleanup()
})

describe('findBeatModel', () => {
  it('returns undefined when the files are missing', () => {
    expect(findBeatModel({ ...paths, models: path.join(tmp.dir, 'nothing') })).toBeUndefined()
  })
})

describe.skipIf(
  skipBecause(NO_FFMPEG || (!model && 'Beat This! model not installed (run `pnpm bootstrap`)')),
)('Beat This! (real model, synthetic music with exact beats)', () => {
  for (const i of [0, 1, 3, 6]) {
    const style = STYLES[i]!
    it(
      `${style.name}: beat F >= 0.9, tempo right, bar starts found`,
      { timeout: 120_000 },
      async () => {
        const tr = synthesize(style, 40, 11)
        const file = path.join(tmp.dir, `${style.name}.wav`)
        await writeWav(file, tr.samples)
        const r = await analyzeBeatsNeural({ ffmpeg: FFMPEG_BIN, file, channels: 2, model: model! })
        expect(r.engine).toBe('neural')
        expect(
          fMeasure(
            tr.beats,
            r.beats.map((b) => b / 1e6),
          ),
        ).toBeGreaterThanOrEqual(0.9)
        expect(Math.abs(r.bpm - tr.bpm) / tr.bpm).toBeLessThan(0.04)
        expect(
          fMeasure(
            tr.downbeats,
            r.downbeats.map((b) => b / 1e6),
          ),
        ).toBeGreaterThanOrEqual(0.6)
      },
    )
  }

  it('beats the DSP tracker on loud off-beat hats', { timeout: 120_000 }, async () => {
    const tr = synthesize(STYLES[6]!, 40, 5)
    const file = path.join(tmp.dir, 'hats.wav')
    await writeWav(file, tr.samples)
    const dsp = await analyzeBeats({ ffmpeg: FFMPEG_BIN, file })
    const neural = await analyzeBeatsNeural({
      ffmpeg: FFMPEG_BIN,
      file,
      channels: 2,
      model: model!,
    })
    const f = (b: number[]) =>
      fMeasure(
        tr.beats,
        b.map((x) => x / 1e6),
      )
    expect(f(neural.beats)).toBeGreaterThan(f(dsp.beats))
  })

  it(
    'the beats job uses the model, caches downbeats and honours engine: dsp',
    {
      timeout: 120_000,
    },
    async () => {
      const store = new MemoryStore()
      const tr = synthesize(STYLES[1]!, 30, 2)
      const src = path.join(tmp.dir, 'song.wav')
      await writeWav(src, tr.samples)
      const asset = makeAsset('a1', 'song.wav', { kind: 'audio', duration: 30_000_000 })
      addAssetFile(paths, store, asset, src)
      const run = (payload: object) =>
        beatsJob.handler(makeContext('beats', payload, paths, store)) as Promise<{ engine: string }>
      expect((await run({ assetId: 'a1' })).engine).toBe('neural')
      expect(store.getAsset('a1')?.downbeats?.length).toBeGreaterThan(3)
      expect((await run({ assetId: 'a1', engine: 'dsp' })).engine).toBe('dsp')
    },
  )
})
