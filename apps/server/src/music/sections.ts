/**
 * Chorus / "best section" finder (pure; unit-tested on synthetic audio).
 *
 * A reel should open on the hook, not on the intro. Popular music is loudest and densest in
 * its chorus/drop, and a chorus usually *enters* with a jump in energy. So:
 *
 * 1. Loudness envelope: mean-square energy per 100 ms frame → dB (`EnergyEnvelope`, fed the
 *    same PCM stream the beat tracker decodes, so analysis needs one decode).
 * 2. Normalise between the 10th and 95th loudness percentiles (robust to silence and peaks),
 *    smooth over 1 s.
 * 3. Score every candidate start (bar starts when known, so the music enters on a downbeat):
 *    mean energy over the reel-length window, plus the energy of its first 8 s (the hook
 *    must land immediately), plus the energy *rise* into it (a section entrance).
 * 4. Earliest best wins ties (first chorus rather than the last).
 */

export const ENVELOPE_RATE = 10 // frames per second

/** Streaming loudness envelope (dBFS per 1/ENVELOPE_RATE s frame). */
export class EnergyEnvelope {
  readonly #frame: number
  readonly #out: number[] = []
  #acc = 0
  #n = 0

  constructor(sampleRate: number) {
    this.#frame = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE))
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]!
      this.#acc += v * v
      if (++this.#n === this.#frame) this.#flush()
    }
  }

  #flush(): void {
    this.#out.push(10 * Math.log10(this.#acc / this.#n + 1e-12))
    this.#acc = 0
    this.#n = 0
  }

  finish(): Float32Array {
    if (this.#n > this.#frame / 2) this.#flush()
    return Float32Array.from(this.#out)
  }
}

export interface Section {
  /** µs */
  start: number
  /** µs */
  end: number
  score: number
}

const percentile = (values: Float32Array, p: number): number => {
  if (values.length === 0) return 0
  const sorted = values.toSorted()
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!
}

/** Envelope (dB) → 0..1 per frame, smoothed over `smoothFrames`. */
export const normalizeEnvelope = (
  env: Float32Array,
  smoothFrames = ENVELOPE_RATE,
): Float32Array => {
  const lo = percentile(env, 0.1)
  const hi = percentile(env, 0.95)
  const range = hi - lo
  const x = new Float32Array(env.length)
  // Flat loudness (a drone, or silence): no section stands out.
  if (range < 1) return x.fill(lo < -80 ? 0 : 1)
  for (let i = 0; i < env.length; i++) x[i] = Math.min(1, Math.max(0, (env[i]! - lo) / range))
  // Centred moving average.
  const half = Math.floor(smoothFrames / 2)
  const prefix = new Float64Array(x.length + 1)
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i]! + x[i]!
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(x.length, i + half + 1)
    out[i] = (prefix[b]! - prefix[a]!) / (b - a)
  }
  return out
}

/**
 * Best start for a `length` µs excerpt. `candidates` (µs, e.g. downbeats) restrict where it
 * may start; without them every 0.5 s is tried. Returns µs times within the track.
 */
export const findBestSection = (
  env: Float32Array,
  opts: { length: number; candidates?: readonly number[]; rate?: number },
): Section => {
  const rate = opts.rate ?? ENVELOPE_RATE
  const n = env.length
  const total = Math.round((n / rate) * 1_000_000)
  const w = Math.max(1, Math.round((opts.length / 1_000_000) * rate))
  if (n === 0 || w >= n) return { start: 0, end: total, score: 0 }

  const x = normalizeEnvelope(env, rate)
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + x[i]!
  const mean = (a: number, b: number): number => {
    const lo = Math.max(0, a)
    const hi = Math.min(n, b)
    return hi > lo ? (prefix[hi]! - prefix[lo]!) / (hi - lo) : 0
  }
  const hook = Math.min(w, 8 * rate)
  const rise = 4 * rate

  const last = n - w
  let starts = (opts.candidates ?? [])
    .map((t) => Math.round((t / 1_000_000) * rate))
    .filter((f) => f >= 0 && f <= last)
  if (starts.length === 0) {
    const step = Math.max(1, Math.round(rate / 2))
    starts = []
    for (let f = 0; f <= last; f += step) starts.push(f)
  }
  starts = [...new Set(starts)].toSorted((a, b) => a - b)

  let best = { frame: 0, score: -Infinity }
  for (const f of starts) {
    const entrance = f > 0 ? Math.max(0, mean(f, f + rise) - mean(f - rise, f)) : 0
    const score = 0.5 * mean(f, f + w) + 0.3 * mean(f, f + hook) + 0.4 * entrance
    if (score > best.score + 1e-6) best = { frame: f, score }
  }
  const start = Math.round((best.frame / rate) * 1_000_000)
  return { start, end: Math.min(total, start + opts.length), score: best.score }
}

/**
 * Overall energy 0..1 for ranking: loudness of the busy parts (75th percentile dBFS,
 * -35 → 0, -10 → 1) and tempo (60 → 0, 150 BPM → 1).
 */
export const trackEnergy = (env: Float32Array, bpm: number): number => {
  if (env.length === 0) return 0
  const loud = Math.min(1, Math.max(0, (percentile(env, 0.75) + 35) / 25))
  const tempo = bpm > 0 ? Math.min(1, Math.max(0, (bpm - 60) / 90)) : 0.5
  return Math.round((0.65 * loud + 0.35 * tempo) * 1000) / 1000
}
