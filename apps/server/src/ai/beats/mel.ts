/**
 * Streaming log-mel spectrogram matching Beat This!'s `LogMelSpect` front end exactly
 * (pure, synchronous; runs inside the beat worker thread):
 *
 * 22.05 kHz mono → STFT (n_fft 1024, hop 441, periodic Hann, centred with reflect padding)
 * → magnitude / √n_fft (torchaudio `normalized='frame_length'`) → 128-band mel projection
 * (torchaudio's `MelScale.fb`, 30 Hz–11 kHz, Slaney scale; loaded from the bootstrap file)
 * → log1p(1000 · mel). Output: 50 frames per second, frame i centred on sample i·441.
 */
import { hann, RealFFT } from './fft.ts'

export const MEL_SAMPLE_RATE = 22_050
export const MEL_FFT = 1024
export const MEL_HOP = 441
export const MEL_BANDS = 128
export const MEL_FPS = MEL_SAMPLE_RATE / MEL_HOP
const BINS = MEL_FFT / 2 + 1
const PAD = MEL_FFT / 2
const LOG_MULTIPLIER = 1000

/** Validate a raw row-major float32 [513, 128] filterbank. */
export const parseFilterbank = (bytes: Uint8Array): Float32Array => {
  if (bytes.byteLength !== BINS * MEL_BANDS * 4) {
    throw new Error(`mel filterbank must be ${BINS}×${MEL_BANDS} float32`)
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

/**
 * Feed samples with `push`, then `finish` for the [frames, 128] row-major spectrogram.
 * Frames are computed as soon as their window is complete, so the STFT overlaps decoding.
 */
export class LogMelStream {
  readonly #fb: Float32Array
  /** Non-zero filterbank range per mel band (most of each column is zero). */
  readonly #lo = new Int32Array(MEL_BANDS)
  readonly #hi = new Int32Array(MEL_BANDS)
  readonly #fft = new RealFFT(MEL_FFT)
  readonly #window = hann(MEL_FFT)
  readonly #frame = new Float32Array(MEL_FFT)
  readonly #mag = new Float32Array(BINS)
  readonly #re = new Float64Array(BINS)
  readonly #im = new Float64Array(BINS)
  /** Unconsumed samples (with the reflected head once it is known). */
  #buf = new Float32Array(MEL_FFT * 8)
  #len = 0
  /** Samples seen; the reflect-padded head needs the first PAD+1 of them. */
  #seen = 0
  #started = false
  #out = new Float32Array(MEL_BANDS * 4096)
  #frames = 0

  constructor(filterbank: Float32Array) {
    if (filterbank.length !== BINS * MEL_BANDS) throw new Error('bad mel filterbank size')
    this.#fb = filterbank
    for (let m = 0; m < MEL_BANDS; m++) {
      let lo = BINS
      let hi = -1
      for (let k = 0; k < BINS; k++) {
        if ((filterbank[k * MEL_BANDS + m] ?? 0) !== 0) {
          lo = Math.min(lo, k)
          hi = k
        }
      }
      this.#lo[m] = lo
      this.#hi[m] = hi
    }
  }

  get frames(): number {
    return this.#frames
  }

  push(samples: Float32Array): void {
    this.#append(samples)
    this.#seen += samples.length
    if (!this.#started) {
      if (this.#len <= PAD) return
      // Centred STFT: reflect-pad the head (x[-k] = x[k]).
      const head = new Float32Array(PAD)
      for (let k = 1; k <= PAD; k++) head[PAD - k] = this.#buf[k] ?? 0
      const rest = this.#buf.slice(0, this.#len)
      this.#len = 0
      this.#append(head)
      this.#append(rest)
      this.#started = true
    }
    this.#drain()
  }

  /** Reflect-pad the tail, emit the remaining frames and return the spectrogram. */
  finish(): Float32Array {
    if (this.#seen === 0) return new Float32Array(0)
    if (!this.#started) {
      // Shorter than half a window: reflect what we have (torch requires more; we just pad).
      const all = this.#buf.slice(0, this.#len)
      const head = new Float32Array(PAD)
      for (let k = 1; k <= PAD; k++) head[PAD - k] = all[Math.min(k, all.length - 1)] ?? 0
      this.#len = 0
      this.#append(head)
      this.#append(all)
      this.#started = true
    }
    const total = 1 + Math.floor(this.#seen / MEL_HOP)
    // Tail reflection: x[n-1+k] → x[n-1-k].
    const tail = new Float32Array(PAD)
    for (let k = 1; k <= PAD; k++) tail[k - 1] = this.#buf[Math.max(0, this.#len - 1 - k)] ?? 0
    this.#append(tail)
    this.#drain()
    return this.#out.slice(0, Math.min(total, this.#frames) * MEL_BANDS)
  }

  #append(samples: Float32Array): void {
    const need = this.#len + samples.length
    if (need > this.#buf.length) {
      const next = new Float32Array(Math.max(need, this.#buf.length * 2))
      next.set(this.#buf.subarray(0, this.#len))
      this.#buf = next
    }
    this.#buf.set(samples, this.#len)
    this.#len = need
  }

  #drain(): void {
    let pos = 0
    while (this.#len - pos >= MEL_FFT) {
      this.#analyse(pos)
      pos += MEL_HOP
    }
    if (pos > 0) {
      this.#buf.copyWithin(0, pos, this.#len)
      this.#len -= pos
    }
  }

  #analyse(offset: number): void {
    const frame = this.#frame
    const win = this.#window
    const buf = this.#buf
    for (let i = 0; i < MEL_FFT; i++) frame[i] = (buf[offset + i] ?? 0) * (win[i] ?? 0)
    const mag = this.#mag
    this.#fft.magnitude(frame, mag, this.#re, this.#im)
    if ((this.#frames + 1) * MEL_BANDS > this.#out.length) {
      const next = new Float32Array(this.#out.length * 2)
      next.set(this.#out)
      this.#out = next
    }
    const out = this.#out
    const base = this.#frames * MEL_BANDS
    const fb = this.#fb
    const scale = 1 / Math.sqrt(MEL_FFT)
    for (let m = 0; m < MEL_BANDS; m++) {
      let s = 0
      const hi = this.#hi[m] ?? -1
      for (let k = this.#lo[m] ?? 0; k <= hi; k++) s += (mag[k] ?? 0) * (fb[k * MEL_BANDS + m] ?? 0)
      out[base + m] = Math.log1p(LOG_MULTIPLIER * s * scale)
    }
    this.#frames++
  }
}
