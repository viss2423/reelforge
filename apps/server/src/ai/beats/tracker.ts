/**
 * Beat tracking (pure, synchronous; runs inside a worker thread).
 *
 * Pipeline
 * 1. Streaming STFT (Hann, N=2048, hop 512 @ 22.05 kHz) → log-compressed spectral flux
 *    onset envelope (+ a low-band flux used for downbeat accents).
 * 2. Tempo: unbiased autocorrelation of the envelope weighted by a log-Gaussian prior
 *    around 120 BPM (σ = 1 octave), parabolic peak interpolation.
 * 3. Beats: dynamic programming (Ellis 2007, "Beat tracking by dynamic programming").
 * 4. Timing refinement: each beat snaps to the strongest energy attack within ±50 ms on a
 *    5.8 ms log-energy envelope — STFT frames are 93 ms wide, which smears onsets.
 * 5. BPM is re-estimated from the refined beat grid (robust mean inter-beat interval),
 *    which is far more precise than the frame-quantised autocorrelation lag.
 * 6. Downbeats: the 4/4 phase whose beats carry the most (low-band weighted) accent.
 */
import { hann, RealFFT } from './fft.ts'

export const BEAT_SAMPLE_RATE = 22_050
const N_FFT = 2048
const HOP = 512
/** Fine envelope block (5.8 ms) for onset timing refinement. */
const FINE = 128
/** log(1 + γ·|X|) compression constant. */
const GAMMA = 100
const LOW_BAND_HZ = 150
/**
 * Frames whose window overlaps the zero padding of the centred STFT (plus the first full
 * window, whose predecessor is padded). Audio that starts abruptly would otherwise produce
 * a fake onset at t≈0 that the DP happily turns into an off-grid first beat.
 */
const EDGE_FRAMES = N_FFT / (2 * HOP) + 1

export interface BeatResult {
  /** Tempo in beats per minute (0 when no beat was found). */
  bpm: number
  /** Beat times in us. */
  beats: number[]
  /** Subset of `beats` estimated to be bar starts (4/4). */
  downbeats: number[]
}

/** Growable Float32 array (amortised O(1) append). */
class FloatList {
  data: Float32Array
  length = 0
  constructor(capacity = 1024) {
    this.data = new Float32Array(capacity)
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = v
  }
  view(): Float32Array {
    return this.data.subarray(0, this.length)
  }
}

/** Streaming onset analysis. Feed mono samples at 22.05 kHz with `push`, then `finish`. */
export class BeatAnalyzer {
  readonly sampleRate: number
  readonly #fft = new RealFFT(N_FFT)
  readonly #window = hann(N_FFT)
  readonly #frame = new Float32Array(N_FFT)
  readonly #mag = new Float32Array(N_FFT / 2 + 1)
  readonly #prev = new Float32Array(N_FFT / 2 + 1)
  readonly #scratchRe = new Float64Array(N_FFT / 2 + 1)
  readonly #scratchIm = new Float64Array(N_FFT / 2 + 1)
  readonly #lowBins: number
  /** Pending samples not yet consumed by a full frame (starts with N/2 zeros: centred frames). */
  #pending = new Float32Array(N_FFT * 2)
  #pendingLen = N_FFT / 2
  #frames = 0
  readonly #flux = new FloatList(8192)
  readonly #lowFlux = new FloatList(8192)
  readonly #fine = new FloatList(32768)
  #fineAcc = 0
  #fineN = 0
  #samples = 0

  constructor(sampleRate = BEAT_SAMPLE_RATE) {
    this.sampleRate = sampleRate
    this.#lowBins = Math.max(2, Math.round((LOW_BAND_HZ * N_FFT) / sampleRate))
  }

  push(samples: Float32Array): void {
    this.#samples += samples.length
    // Fine log-energy envelope.
    let acc = this.#fineAcc
    let n = this.#fineN
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0
      acc += s * s
      if (++n === FINE) {
        this.#fine.push(Math.log10(acc / FINE + 1e-10))
        acc = 0
        n = 0
      }
    }
    this.#fineAcc = acc
    this.#fineN = n
    this.#append(samples)
    this.#drain()
  }

  /** Flush (zero-pad the tail like a centred STFT) and run tempo + beat tracking. */
  finish(): BeatResult {
    this.#append(new Float32Array(N_FFT / 2))
    this.#drain()
    return trackBeats(
      this.#flux.view(),
      this.#lowFlux.view(),
      this.#fine.view(),
      this.sampleRate,
      this.#samples,
    )
  }

  #append(samples: Float32Array): void {
    const need = this.#pendingLen + samples.length
    if (need > this.#pending.length) {
      const next = new Float32Array(Math.max(need, this.#pending.length * 2))
      next.set(this.#pending.subarray(0, this.#pendingLen))
      this.#pending = next
    }
    this.#pending.set(samples, this.#pendingLen)
    this.#pendingLen = need
  }

  #drain(): void {
    let pos = 0
    const buf = this.#pending
    while (this.#pendingLen - pos >= N_FFT) {
      this.#analyse(buf, pos)
      pos += HOP
    }
    if (pos > 0) {
      buf.copyWithin(0, pos, this.#pendingLen)
      this.#pendingLen -= pos
    }
  }

  #analyse(buf: Float32Array, offset: number): void {
    const frame = this.#frame
    const win = this.#window
    for (let i = 0; i < N_FFT; i++) frame[i] = (buf[offset + i] ?? 0) * (win[i] ?? 0)
    const mag = this.#mag
    this.#fft.magnitude(frame, mag, this.#scratchRe, this.#scratchIm)
    const prev = this.#prev
    // Normalise so a full-scale sine peaks near 1 (Hann coherent gain = N/4).
    const norm = 4 / N_FFT
    let flux = 0
    let low = 0
    for (let k = 1; k < mag.length; k++) {
      const v = Math.log1p(GAMMA * (mag[k] ?? 0) * norm)
      const d = v - (prev[k] ?? 0)
      if (d > 0) {
        flux += d
        if (k <= this.#lowBins) low += d
      }
      prev[k] = v
    }
    // Padded edge frames measure the padding→audio step, not an onset.
    const edge = this.#frames < EDGE_FRAMES
    this.#flux.push(edge ? 0 : flux)
    this.#lowFlux.push(edge ? 0 : low)
    this.#frames++
  }
}

const mean = (a: ArrayLike<number>): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] ?? 0
  return a.length ? s / a.length : 0
}

const std = (a: ArrayLike<number>, m = mean(a)): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += ((a[i] ?? 0) - m) ** 2
  return a.length ? Math.sqrt(s / a.length) : 0
}

/** Tempo (BPM) from the onset envelope via prior-weighted autocorrelation. */
export const estimateTempo = (env: Float32Array, fps: number, priorBpm = 120): number => {
  const n = env.length
  const minLag = Math.max(1, Math.floor((fps * 60) / 300))
  const maxLag = Math.min(n - 2, Math.ceil((fps * 60) / 30))
  if (maxLag <= minLag + 1) return 0
  // Light Gaussian smoothing (σ ≈ 1 frame): a period that is not a whole number of frames
  // splits each onset's correlation between two adjacent lags, which would otherwise let
  // the (integer) double period win.
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    x[i] =
      0.4 * (env[i] ?? 0) +
      0.24 * ((env[i - 1] ?? 0) + (env[i + 1] ?? 0)) +
      0.06 * ((env[i - 2] ?? 0) + (env[i + 2] ?? 0))
  }
  const m = mean(x)
  for (let i = 0; i < n; i++) x[i] = (x[i] ?? 0) - m
  const ac = new Float64Array(maxLag + 2)
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let s = 0
    for (let i = lag; i < n; i++) s += (x[i] ?? 0) * (x[i - lag] ?? 0)
    ac[lag] = s / (n - lag) // unbiased: long lags are not penalised for fewer overlaps
  }
  let best = -1
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    const a = ac[lag] ?? 0
    // Only local maxima are candidate periods.
    if (a <= (ac[lag - 1] ?? 0) || a < (ac[lag + 1] ?? 0)) continue
    const bpm = (60 * fps) / lag
    const w = Math.exp(-0.5 * Math.log2(bpm / priorBpm) ** 2)
    if (a * w > bestScore) {
      bestScore = a * w
      best = lag
    }
  }
  if (best < 0 || bestScore <= 0) return 0
  const y0 = ac[best - 1] ?? 0
  const y1 = ac[best] ?? 0
  const y2 = ac[best + 1] ?? 0
  const denom = y0 - 2 * y1 + y2
  const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0
  return (60 * fps) / (best + shift)
}

/** Ellis-style DP beat tracker. Returns beat frame indices. */
export const dpBeats = (env: Float32Array, period: number, tightness = 100): number[] => {
  const n = env.length
  if (n === 0 || !(period > 1)) return []
  // Local score: envelope smoothed with a Gaussian of width period/32 (as in librosa).
  const half = Math.round(period)
  const kernel = new Float32Array(2 * half + 1)
  for (let i = -half; i <= half; i++) kernel[i + half] = Math.exp(-0.5 * ((i * 32) / period) ** 2)
  const local = new Float32Array(n)
  for (let t = 0; t < n; t++) {
    let s = 0
    for (let k = -half; k <= half; k++) {
      const j = t + k
      if (j >= 0 && j < n) s += (env[j] ?? 0) * (kernel[k + half] ?? 0)
    }
    local[t] = s
  }
  const cum = new Float32Array(n)
  const back = new Int32Array(n).fill(-1)
  const lo = Math.round(2 * period)
  const hi = Math.max(1, Math.round(period / 2))
  // Precompute the transition penalty per distance.
  const penalty = new Float32Array(lo + 1)
  for (let d = hi; d <= lo; d++) penalty[d] = -tightness * Math.log(d / period) ** 2
  for (let t = 0; t < n; t++) {
    let best = -Infinity
    let arg = -1
    for (let d = hi; d <= lo && t - d >= 0; d++) {
      const v = (cum[t - d] ?? 0) + (penalty[d] ?? 0)
      if (v > best) {
        best = v
        arg = t - d
      }
    }
    cum[t] = (local[t] ?? 0) + (arg >= 0 ? Math.max(0, best) : 0)
    back[t] = arg >= 0 && best > 0 ? arg : -1
  }
  // Last beat: the latest local maximum of the cumulative score above half the median peak.
  const peaks: number[] = []
  for (let t = 1; t < n - 1; t++) {
    if ((cum[t] ?? 0) > (cum[t - 1] ?? 0) && (cum[t] ?? 0) >= (cum[t + 1] ?? 0)) peaks.push(t)
  }
  if (peaks.length === 0) return []
  const vals = peaks.map((t) => cum[t] ?? 0).toSorted((a, b) => a - b)
  const median = vals[vals.length >> 1] ?? 0
  let last = peaks[peaks.length - 1] ?? 0
  for (let i = peaks.length - 1; i >= 0; i--) {
    const t = peaks[i] ?? 0
    if ((cum[t] ?? 0) >= 0.5 * median) {
      last = t
      break
    }
  }
  const beats: number[] = []
  for (let t = last; t >= 0; t = back[t] ?? -1) beats.push(t)
  beats.reverse()
  // Trim weak leading/trailing beats (silence before/after the music).
  let rms = 0
  for (const b of beats) rms += (local[b] ?? 0) ** 2
  rms = Math.sqrt(rms / Math.max(1, beats.length))
  let s = 0
  let e = beats.length
  while (s < e && (local[beats[s] ?? 0] ?? 0) < 0.5 * rms) s++
  while (e > s && (local[beats[e - 1] ?? 0] ?? 0) < 0.5 * rms) e--
  return beats.slice(s, e)
}

/** Snap a coarse beat time (seconds) to the strongest attack on the fine envelope. */
const refine = (t: number, fine: Float32Array, sr: number): number => {
  const blockSec = FINE / sr
  const center = Math.round(t / blockSec)
  const radius = Math.ceil(0.05 / blockSec)
  let best = 0
  let arg = -1
  for (let i = Math.max(1, center - radius); i <= Math.min(fine.length - 1, center + radius); i++) {
    const d = (fine[i] ?? 0) - (fine[i - 1] ?? 0)
    if (d > best) {
      best = d
      arg = i
    }
  }
  // Require a clear attack (≥ 3 dB power jump = 0.3 in log10) or keep the DP estimate. The
  // attack starts somewhere inside the first loud block: report its centre (±2.9 ms).
  return arg >= 0 && best >= 0.3 ? (arg + 0.5) * blockSec : t
}

/** Robust tempo from beat times: mean of inter-beat intervals within ±15 % of the median. */
export const bpmFromBeats = (times: readonly number[]): number => {
  if (times.length < 3) return 0
  const ibis: number[] = []
  for (let i = 1; i < times.length; i++) ibis.push((times[i] ?? 0) - (times[i - 1] ?? 0))
  const sorted = ibis.toSorted((a, b) => a - b)
  const med = sorted[sorted.length >> 1] ?? 0
  const good = ibis.filter((x) => Math.abs(x - med) <= 0.15 * med)
  const m = mean(good)
  return m > 0 ? 60 / m : 0
}

/** Pick the 4/4 bar phase with the strongest average accent. */
export const downbeatPhase = (accents: readonly number[], meter = 4): number => {
  if (accents.length < meter * 2) return 0
  let best = 0
  let bestScore = -Infinity
  for (let p = 0; p < meter; p++) {
    let s = 0
    let c = 0
    for (let i = p; i < accents.length; i += meter) {
      s += accents[i] ?? 0
      c++
    }
    if (c && s / c > bestScore) {
      bestScore = s / c
      best = p
    }
  }
  return best
}

/**
 * Subtract the local mean (±`radius` frames) and half-wave rectify. Broadband textures
 * (noise, pads, reverb tails) raise spectral flux everywhere; without this floor removal
 * the DP extends the beat grid into intros/outros that contain no onsets.
 */
export const removeFloor = (flux: Float32Array, radius: number): Float32Array => {
  const n = flux.length
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] ?? 0) + (flux[i] ?? 0)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius)
    const hi = Math.min(n, i + radius + 1)
    const m = ((prefix[hi] ?? 0) - (prefix[lo] ?? 0)) / (hi - lo)
    out[i] = Math.max(0, (flux[i] ?? 0) - m)
  }
  return out
}

/** Full analysis from precomputed envelopes (exported for tests). */
export const trackBeats = (
  flux: Float32Array,
  lowFlux: Float32Array,
  fine: Float32Array,
  sr: number,
  totalSamples: number,
): BeatResult => {
  const fps = sr / HOP
  if (flux.length < 8) return { bpm: 0, beats: [], downbeats: [] }
  const env = removeFloor(flux, Math.round(fps))
  const sd = std(env)
  if (sd < 1e-6) return { bpm: 0, beats: [], downbeats: [] }
  for (let i = 0; i < env.length; i++) env[i] = (env[i] ?? 0) / sd
  const tempo = estimateTempo(env, fps)
  if (tempo <= 0) return { bpm: 0, beats: [], downbeats: [] }
  const frames = dpBeats(env, (60 * fps) / tempo)
  const duration = totalSamples / sr
  const times = frames.map((f) => Math.min(duration, refine(f / fps, fine, sr)))
  // Refinement could, in pathological cases, reorder neighbours; keep the grid monotonic.
  for (let i = 1; i < times.length; i++)
    times[i] = Math.max(times[i] ?? 0, (times[i - 1] ?? 0) + 1e-3)

  const lowSd = std(lowFlux) || 1
  const accents = frames.map((f) => {
    let a = 0
    for (let k = Math.max(0, f - 1); k <= Math.min(flux.length - 1, f + 1); k++) {
      a = Math.max(a, (env[k] ?? 0) + (lowFlux[k] ?? 0) / lowSd)
    }
    return a
  })
  const phase = downbeatPhase(accents)
  const beats = times.map((t) => Math.round(t * 1_000_000))
  const downbeats = beats.length >= 8 ? beats.filter((_, i) => i % 4 === phase) : []
  const refined = bpmFromBeats(times)
  return { bpm: Math.round((refined || tempo) * 100) / 100, beats, downbeats }
}
