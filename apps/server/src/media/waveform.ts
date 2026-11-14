/**
 * Audio peaks for timeline waveforms: per 10 ms bucket the min and max sample as int8.
 * FFmpeg decodes to 16 kHz mono s16le on stdout and peaks are folded in as the bytes stream
 * in — memory stays O(buckets) no matter how long the file is.
 *
 * waveform.json: { bucketUs: 10000, count: n, peaks: [min0, max0, min1, max1, ...] }
 */
import { rename, writeFile } from 'node:fs/promises'
import { FFMPEG_BASE, run } from './ffmpeg.ts'
import type { MediaInfo } from './probe.ts'

export const WAVEFORM_BUCKET_US = 10_000
export const WAVEFORM_SAMPLE_RATE = 16_000
const SAMPLES_PER_BUCKET = (WAVEFORM_SAMPLE_RATE * WAVEFORM_BUCKET_US) / 1_000_000

export interface WaveformData {
  bucketUs: number
  count: number
  /** Interleaved [min, max] int8 pairs. */
  peaks: number[]
}

/** Streaming min/max reducer over s16le mono PCM. */
export class PeakAccumulator {
  readonly #perBucket: number
  #peaks: Int8Array
  #count = 0
  #inBucket = 0
  #min = 127
  #max = -128
  #carry = -1

  constructor(samplesPerBucket = SAMPLES_PER_BUCKET, expectedBuckets = 1024) {
    this.#perBucket = samplesPerBucket
    this.#peaks = new Int8Array(Math.max(2, expectedBuckets * 2))
  }

  #sample(s: number): void {
    const v = s >> 8
    if (v < this.#min) this.#min = v
    if (v > this.#max) this.#max = v
    if (++this.#inBucket === this.#perBucket) this.#flush()
  }

  #flush(): void {
    if (this.#inBucket === 0) return
    if (this.#count * 2 + 2 > this.#peaks.length) {
      const next = new Int8Array(this.#peaks.length * 2)
      next.set(this.#peaks)
      this.#peaks = next
    }
    this.#peaks[this.#count * 2] = this.#min
    this.#peaks[this.#count * 2 + 1] = this.#max
    this.#count++
    this.#inBucket = 0
    this.#min = 127
    this.#max = -128
  }

  push(chunk: Buffer): void {
    let i = 0
    // A sample can straddle two chunks.
    if (this.#carry >= 0 && chunk.length > 0) {
      this.#sample((((chunk[0]! << 8) | this.#carry) << 16) >> 16)
      this.#carry = -1
      i = 1
    }
    const end = chunk.length - ((chunk.length - i) & 1)
    for (; i < end; i += 2) this.#sample(chunk.readInt16LE(i))
    if (end < chunk.length) this.#carry = chunk[end]!
  }

  finish(): Int8Array {
    this.#flush()
    return this.#peaks.subarray(0, this.#count * 2)
  }
}

/** Decodes the first audio stream and writes waveform.json atomically. */
export const makeWaveform = async (opts: {
  ffmpeg: string
  info: MediaInfo
  input: string
  output: string
  signal: AbortSignal
}): Promise<{ count: number }> => {
  const { info } = opts
  if (info.audioStreamIndex === undefined) throw new Error('no audio stream')
  const expected = Math.ceil((info.duration ?? 0) / WAVEFORM_BUCKET_US) + 1
  const acc = new PeakAccumulator(SAMPLES_PER_BUCKET, expected)
  await run(
    opts.ffmpeg,
    [
      ...FFMPEG_BASE,
      '-i',
      opts.input,
      '-map',
      `0:${info.audioStreamIndex}`,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(WAVEFORM_SAMPLE_RATE),
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      'pipe:1',
    ],
    { signal: opts.signal, lowPriority: true, onStdout: (c) => acc.push(c) },
  )
  const peaks = acc.finish()
  const json = `{"bucketUs":${WAVEFORM_BUCKET_US},"count":${peaks.length / 2},"peaks":[${peaks.join(',')}]}`
  await writeFile(`${opts.output}.part`, json)
  await rename(`${opts.output}.part`, opts.output)
  return { count: peaks.length / 2 }
}
