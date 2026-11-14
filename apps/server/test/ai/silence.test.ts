import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  detectSilence,
  FRAME_US,
  LevelMeter,
  silenceJob,
  speechLevel,
} from '../../src/ai/silence.ts'
import type { SilenceResult } from '../../src/ai/silence.ts'
import {
  addAssetFile,
  ffmpeg,
  makeAsset,
  makeContext,
  makePaths,
  makeTempDir,
  MemoryStore,
  NO_FFMPEG,
  skipBecause,
} from './helpers.ts'

/** Per-frame levels from a list of [durationUs, dB] runs. */
const levels = (runs: Array<[number, number]>): Float32Array => {
  const out: number[] = []
  for (const [d, db] of runs) for (let i = 0; i < d / FRAME_US; i++) out.push(db)
  return Float32Array.from(out)
}

describe('LevelMeter', () => {
  it('measures 10 ms RMS frames in dBFS regardless of chunking', () => {
    const sr = 16_000
    const sine = Float32Array.from(
      { length: sr },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr),
    )
    const a = new LevelMeter(sr)
    a.push(sine)
    const b = new LevelMeter(sr)
    for (let i = 0; i < sine.length; i += 333) b.push(sine.subarray(i, i + 333))
    const la = a.finish()
    const lb = b.finish()
    expect(la.length).toBe(100)
    expect(Array.from(lb)).toEqual(Array.from(la))
    // RMS of a 0.5-amplitude sine = 0.354 → -9.03 dBFS.
    expect(Math.abs((la[50] ?? 0) + 9.03)).toBeLessThan(0.15)
  })

  it('includes a trailing partial frame', () => {
    const m = new LevelMeter(16_000)
    m.push(new Float32Array(165).fill(0.1))
    expect(m.finish().length).toBe(2)
  })
})

describe('speechLevel', () => {
  it('ignores frames below the -70 dB gate and returns the 80th percentile', () => {
    const l = levels([
      [1_000_000, -90],
      [800_000, -20],
      [200_000, -10],
    ])
    expect(speechLevel(l)).toBe(-10)
    expect(speechLevel(levels([[500_000, -100]]))).toBeUndefined()
  })
})

describe('detectSilence', () => {
  it('finds silences, pads them and skips gaps shorter than minSilence', () => {
    const l = levels([
      [1_000_000, -15],
      [800_000, -90],
      [1_500_000, -15],
      [200_000, -90],
      [1_000_000, -15],
      [1_000_000, -90],
    ])
    const r = detectSilence(l, 5_500_000)
    expect(r.thresholdDb).toBe(-40)
    expect(r.ranges).toEqual([
      { start: 1_100_000, end: 1_700_000 },
      { start: 4_600_000, end: 5_500_000 },
    ])
  })

  it('does not pad at the file edges', () => {
    const r = detectSilence(
      levels([
        [600_000, -90],
        [1_000_000, -20],
        [600_000, -90],
      ]),
      2_200_000,
    )
    expect(r.ranges).toEqual([
      { start: 0, end: 500_000 },
      { start: 1_700_000, end: 2_200_000 },
    ])
  })

  it('bridges short clicks inside a silence', () => {
    const r = detectSilence(
      levels([
        [1_000_000, -20],
        [300_000, -90],
        [10_000, -10],
        [300_000, -90],
        [1_000_000, -20],
      ]),
      2_610_000,
    )
    expect(r.ranges).toEqual([{ start: 1_100_000, end: 1_510_000 }])
  })

  it('honours explicit threshold, minSilence and padding', () => {
    const l = levels([
      [1_000_000, -20],
      [400_000, -46],
      [1_000_000, -20],
    ])
    expect(detectSilence(l, 2_400_000).ranges).toHaveLength(1) // adaptive: -20 - 25 = -45 dB
    expect(detectSilence(l, 2_400_000, { thresholdDb: -50 }).ranges).toHaveLength(0)
    expect(detectSilence(l, 2_400_000, { minSilence: 500_000 }).ranges).toHaveLength(0)
    expect(detectSilence(l, 2_400_000, { padding: 0 }).ranges).toEqual([
      { start: 1_000_000, end: 1_400_000 },
    ])
  })

  it('treats a fully silent file as one range and floors the threshold at -50 dB', () => {
    const r = detectSilence(levels([[1_000_000, -100]]), 1_000_000)
    expect(r.ranges).toEqual([{ start: 0, end: 1_000_000 }])
    expect(r.thresholdDb).toBe(-50)
    expect(r.speechDb).toBeUndefined()
  })

  it('handles empty input', () => {
    expect(detectSilence(new Float32Array(0), 0).ranges).toEqual([])
  })
})

describe.skipIf(skipBecause(NO_FFMPEG))('silence job (FFmpeg)', () => {
  let tmp: ReturnType<typeof makeTempDir>
  const paths = (): ReturnType<typeof makePaths> => makePaths(tmp.dir)
  beforeAll(() => {
    tmp = makeTempDir('silence')
  })
  afterAll(() => tmp.cleanup())

  /** Concatenate tone / silence / noise segments into a WAV. */
  const pattern = (name: string, segs: Array<['tone' | 'silence' | 'noise', number]>): string => {
    const file = path.join(tmp.dir, name)
    const parts = segs.map(([kind, d], i) => {
      const src =
        kind === 'tone'
          ? `sine=frequency=440:sample_rate=48000:duration=${d},volume=4`
          : kind === 'noise'
            ? `anoisesrc=color=white:amplitude=0.005:sample_rate=48000:duration=${d}`
            : `anullsrc=r=48000:cl=mono,atrim=duration=${d}`
      return `${src}[s${i}]`
    })
    const graph = `${parts.join(';')};${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${segs.length}:v=0:a=1`
    ffmpeg(['-filter_complex', graph, '-ac', '1', file])
    return file
  }

  const run = async (
    file: string,
    payload: Record<string, unknown> = {},
  ): Promise<SilenceResult> => {
    const store = new MemoryStore()
    const p = paths()
    const id = path.basename(file, '.wav')
    addAssetFile(p, store, makeAsset(id, `${id}.wav`, { kind: 'audio' }), file)
    const ctx = makeContext('silence', { assetId: id, ...payload }, p, store)
    const r = (await silenceJob.handler(ctx)) as SilenceResult
    expect(ctx.progressLog.at(-1)?.p).toBe(1)
    return r
  }

  const expectRanges = (
    actual: SilenceResult['ranges'],
    expected: Array<[number, number]>,
  ): void => {
    expect(actual).toHaveLength(expected.length)
    expected.forEach(([s, e], i) => {
      expect(Math.abs((actual[i]?.start ?? -1) - s * 1e6)).toBeLessThanOrEqual(20_000)
      expect(Math.abs((actual[i]?.end ?? -1) - e * 1e6)).toBeLessThanOrEqual(20_000)
    })
  }

  it('finds exact ranges in a tone/silence pattern (±20 ms)', async () => {
    const file = pattern('p1.wav', [
      ['tone', 1],
      ['silence', 0.8],
      ['tone', 1.5],
      ['silence', 0.2],
      ['tone', 1],
      ['silence', 1],
    ])
    const r = await run(file)
    expect(r.ranges).toHaveLength(2)
    expectRanges(r.ranges, [
      [1.1, 1.7],
      [4.6, 5.5],
    ])
  })

  it('adapts the threshold to a noisy floor', async () => {
    const file = pattern('p2.wav', [
      ['silence', 0.5],
      ['tone', 1],
      ['noise', 1],
      ['tone', 1],
    ])
    const r = await run(file)
    // Tone RMS ≈ -9 dB → threshold -34 dB; white noise at 0.005 amplitude ≈ -51 dB is silence.
    expect(r.thresholdDb).toBeCloseTo(-34, 0)
    expectRanges(r.ranges, [
      [0, 0.4],
      [1.6, 2.4],
    ])
    const fixed = await run(file, { thresholdDb: -60, padding: 0 })
    expectRanges(fixed.ranges, [[0, 0.5]])
  })

  it('rejects images and invalid payloads', async () => {
    const store = new MemoryStore()
    const p = paths()
    const png = path.join(tmp.dir, 'x.png')
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', png])
    addAssetFile(p, store, makeAsset('img', 'x.png', { kind: 'image' }), png)
    await expect(
      silenceJob.handler(makeContext('silence', { assetId: 'img' }, p, store)),
    ).rejects.toThrow(/no audio/)
    await expect(
      silenceJob.handler(makeContext('silence', { assetId: '../etc' }, p, store)),
    ).rejects.toThrow(/invalid payload/)
    await expect(
      silenceJob.handler(makeContext('silence', { assetId: 'a', minSilence: 1 }, p, store)),
    ).rejects.toThrow(/minSilence/)
  })
})
