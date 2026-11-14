/**
 * Silence detection for "remove silences" / jump-cut editing.
 *
 * Instead of two FFmpeg passes (ebur128/astats to measure, then silencedetect), audio is
 * decoded ONCE to 16 kHz mono PCM and analysed in-process: 10 ms RMS frames give both the
 * speech level (for the adaptive threshold) and the silent runs. RMS windows are also more
 * robust than silencedetect's per-sample peak gate, which a single click can defeat.
 */
import type { Range } from '@reelforge/core'
import type { JobDefinition } from '../contracts.ts'
import { resolveAsset, streamPcm } from './media.ts'
import { parsePayload, SilencePayloadSchema } from './payloads.ts'

export const SILENCE_SAMPLE_RATE = 16_000
/** Analysis frame: 10 ms. */
export const FRAME_US = 10_000
/** Absolute gate below which frames never count towards the speech level (EBU R128 uses -70). */
const GATE_DB = -70

export interface SilenceOptions {
  /** Fixed threshold in dBFS; default adaptive: max(-50, speechLevel - 25). */
  thresholdDb?: number
  /** Minimum silence length in us (default 350 ms). */
  minSilence?: number
  /** Breath kept on each side of a cut in us (default 100 ms). */
  padding?: number
  /** Non-silent blips shorter than this inside a silence are ignored (us, default 20 ms). */
  minNoise?: number
}

export interface SilenceResult {
  /** Silent ranges in source time (us), already shrunk by `padding`. */
  ranges: Range[]
  thresholdDb: number
  /** Estimated speech level in dBFS (undefined when the file is entirely silent). */
  speechDb?: number
}

/** Accumulates 10 ms RMS levels (dBFS) from a stream of mono samples. */
export class LevelMeter {
  readonly #frameLen: number
  #levels = new Float32Array(4096)
  #count = 0
  #acc = 0
  #n = 0

  constructor(sampleRate: number) {
    this.#frameLen = Math.round((sampleRate * FRAME_US) / 1_000_000)
  }

  push(samples: Float32Array): void {
    const len = this.#frameLen
    let acc = this.#acc
    let n = this.#n
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0
      acc += s * s
      if (++n === len) {
        this.#append(acc / len)
        acc = 0
        n = 0
      }
    }
    this.#acc = acc
    this.#n = n
  }

  /** Levels per frame; a trailing partial frame is included. */
  finish(): Float32Array {
    if (this.#n > 0) this.#append(this.#acc / this.#n)
    this.#n = 0
    this.#acc = 0
    return this.#levels.subarray(0, this.#count)
  }

  #append(meanSquare: number): void {
    if (this.#count === this.#levels.length) {
      const next = new Float32Array(this.#levels.length * 2)
      next.set(this.#levels)
      this.#levels = next
    }
    this.#levels[this.#count++] = 10 * Math.log10(meanSquare + 1e-12)
  }
}

/** Robust speech level: 80th percentile of frames above the absolute gate. */
export const speechLevel = (levels: Float32Array): number | undefined => {
  const gated = levels.filter((v) => v > GATE_DB).sort()
  if (gated.length === 0) return undefined
  return gated[Math.min(gated.length - 1, Math.floor(gated.length * 0.8))]
}

/**
 * Find silent ranges from per-frame levels.
 * @param durationUs exact media duration, used to close a trailing silence.
 */
export const detectSilence = (
  levels: Float32Array,
  durationUs: number,
  opts: SilenceOptions = {},
): SilenceResult => {
  const speechDb = speechLevel(levels)
  const thresholdDb = opts.thresholdDb ?? Math.max(-50, (speechDb ?? -50) - 25)
  const minSilence = opts.minSilence ?? 350_000
  const pad = opts.padding ?? 100_000
  const minNoiseFrames = Math.round((opts.minNoise ?? 20_000) / FRAME_US)
  const n = levels.length

  // Silent mask, then bridge short non-silent blips that sit between silent frames.
  const silent = new Uint8Array(n)
  for (let i = 0; i < n; i++) silent[i] = (levels[i] ?? 0) < thresholdDb ? 1 : 0
  for (let i = 0; i < n;) {
    if (silent[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && !silent[j]) j++
    if (i > 0 && j < n && j - i <= minNoiseFrames) silent.fill(1, i, j)
    i = j
  }

  const ranges: Range[] = []
  for (let i = 0; i < n;) {
    if (!silent[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && silent[j]) j++
    const s = i * FRAME_US
    const e = j >= n ? durationUs : Math.min(durationUs, j * FRAME_US)
    if (e - s >= minSilence) {
      // No breath is needed before the first or after the last sound of the file.
      const start = i === 0 ? 0 : s + pad
      const end = j >= n ? durationUs : e - pad
      if (end > start) ranges.push({ start: Math.round(start), end: Math.round(end) })
    }
    i = j
  }
  return speechDb === undefined ? { ranges, thresholdDb } : { ranges, thresholdDb, speechDb }
}

export const silenceJob: JobDefinition = {
  kind: 'silence',
  resource: 'cpu',
  defaultPriority: 20,
  handler: async (ctx) => {
    const opts = parsePayload(SilencePayloadSchema, ctx.payload)
    const { asset, file } = resolveAsset(ctx, opts.assetId)
    if (asset.kind === 'image') throw new Error('images have no audio')
    const total = asset.duration ?? 0
    const meter = new LevelMeter(SILENCE_SAMPLE_RATE)
    ctx.progress(0, 'Analysing audio levels')
    const samples = await streamPcm({
      ffmpeg: ctx.tools.ffmpeg,
      file,
      sampleRate: SILENCE_SAMPLE_RATE,
      signal: ctx.signal,
      onSamples: (s) => meter.push(s),
      onTime: (t) => {
        if (total > 0) ctx.progress(Math.min(0.99, t / total), 'Analysing audio levels')
      },
    })
    const durationUs = Math.round((samples * 1_000_000) / SILENCE_SAMPLE_RATE)
    const result = detectSilence(meter.finish(), durationUs, opts)
    ctx.progress(1, `${result.ranges.length} silences found`)
    return result
  },
}
