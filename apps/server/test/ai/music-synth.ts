/**
 * Synthetic music with exact beat/downbeat ground truth, for beat-tracker tests and the
 * benchmark (no binary fixtures in git). Each style exercises a known failure mode:
 * off-beat hi-hats, syncopated kicks, swing, no drums at all, 3/4, tempo drift, noise.
 */
import { writeFile } from 'node:fs/promises'

export const SYNTH_RATE = 44_100

export interface SynthTrack {
  name: string
  /** Interleaved stereo float samples. */
  samples: Float32Array
  /** Ground-truth beat and downbeat times in seconds. */
  beats: number[]
  downbeats: number[]
  bpm: number
  meter: number
}

/** Deterministic PRNG (mulberry32). */
export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Voice = (buf: Float32Array, at: number, gain: number, rnd: () => number) => void

const add = (buf: Float32Array, i: number, v: number, pan = 0): void => {
  if (i < 0 || 2 * i + 1 >= buf.length) return
  buf[2 * i] = (buf[2 * i] ?? 0) + v * (1 - pan)
  buf[2 * i + 1] = (buf[2 * i + 1] ?? 0) + v * (1 + pan)
}

const kick: Voice = (buf, at, gain) => {
  const n = Math.round(0.35 * SYNTH_RATE)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SYNTH_RATE
    phase += (2 * Math.PI * (50 + 110 * Math.exp(-t * 30))) / SYNTH_RATE
    add(buf, at + i, gain * Math.sin(phase) * Math.exp(-t * 9))
  }
}

const snare: Voice = (buf, at, gain, rnd) => {
  const n = Math.round(0.22 * SYNTH_RATE)
  let lp = 0
  for (let i = 0; i < n; i++) {
    const t = i / SYNTH_RATE
    const noise = rnd() * 2 - 1
    lp += 0.5 * (noise - lp)
    const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25)
    add(buf, at + i, gain * (0.7 * (noise - lp) * Math.exp(-t * 18) + 0.5 * body), 0.1)
  }
}

const hat: Voice = (buf, at, gain, rnd) => {
  const n = Math.round(0.05 * SYNTH_RATE)
  let prev = 0
  for (let i = 0; i < n; i++) {
    const noise = rnd() * 2 - 1
    add(buf, at + i, gain * (noise - prev) * Math.exp((-i / SYNTH_RATE) * 70), -0.3)
    prev = noise
  }
}

/** Plucked/struck harmonic tone (piano-ish), frequency in Hz. */
const tone =
  (freq: number, dur: number, decay = 3): Voice =>
  (buf, at, gain) => {
    const n = Math.round(dur * SYNTH_RATE)
    for (let i = 0; i < n; i++) {
      const t = i / SYNTH_RATE
      const env = Math.min(1, t / 0.004) * Math.exp(-t * decay)
      let v = 0
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * freq * h * t) / (h * h)
      add(buf, at + i, gain * env * v, 0.2)
    }
  }

const midi = (n: number): number => 440 * 2 ** ((n - 69) / 12)

/** Chord progression (I–V–vi–IV in C) as MIDI notes per bar. */
const PROGRESSION = [
  [60, 64, 67],
  [59, 62, 67],
  [57, 60, 64],
  [57, 60, 65],
]

interface Style {
  name: string
  bpm: number
  meter: number
  /** BPM at the end (linear tempo ramp); default constant. */
  endBpm?: number
  /** Timing jitter (s, uniform ±) applied to every hit. */
  jitter?: number
  /** Swing ratio for off-beat 8ths/16ths (0.5 = straight). */
  swing?: number
  noiseDb?: number
  /** Per beat-in-bar: list of [voice, fraction-of-beat offset, gain]. */
  pattern: (beatInBar: number, bar: number) => Array<[Voice, number, number]>
}

const chordHits = (bar: number, gain: number, dur = 0.9): Array<[Voice, number, number]> =>
  (PROGRESSION[bar % 4] ?? []).map((n): [Voice, number, number] => [tone(midi(n), dur), 0, gain])

export const STYLES: Style[] = [
  {
    name: 'edm-128',
    bpm: 128,
    meter: 4,
    pattern: (b, bar) => [
      [kick, 0, 0.9],
      ...(b % 2 === 1 ? [[snare, 0, 0.5] as [Voice, number, number]] : []),
      [hat, 0.5, 0.35],
      [tone(midi(36 + ((PROGRESSION[bar % 4]?.[0] ?? 60) % 12)), 0.2, 8), 0.5, 0.35],
      ...(b === 0 ? chordHits(bar, 0.08, 1.8) : []),
    ],
  },
  {
    name: 'hiphop-90-swing',
    bpm: 90,
    meter: 4,
    swing: 0.62,
    pattern: (b, bar) => [
      ...(b === 0 || b === 2 ? [[kick, 0, 0.9] as [Voice, number, number]] : []),
      ...(b === 1 ? [[kick, 0.75, 0.6] as [Voice, number, number]] : []),
      ...(b % 2 === 1 ? [[snare, 0, 0.6] as [Voice, number, number]] : []),
      [hat, 0, 0.25],
      [hat, 0.5, 0.2],
      ...(b === 0 ? chordHits(bar, 0.07, 2.4) : []),
    ],
  },
  {
    name: 'dnb-174',
    bpm: 174,
    meter: 4,
    pattern: (b, bar) => [
      ...(b === 0 ? [[kick, 0, 0.9] as [Voice, number, number]] : []),
      ...(b === 2 ? [[kick, 0.5, 0.8] as [Voice, number, number]] : []),
      ...(b % 2 === 1 ? [[snare, 0, 0.7] as [Voice, number, number]] : []),
      [hat, 0, 0.2],
      [hat, 0.5, 0.2],
      ...(b === 0 ? chordHits(bar, 0.06, 1.2) : []),
    ],
  },
  {
    name: 'piano-100-no-drums',
    bpm: 100,
    meter: 4,
    jitter: 0.008,
    pattern: (b, bar) => {
      const chord = PROGRESSION[bar % 4] ?? [60]
      const root = chord[0] ?? 60
      return [
        [tone(midi(root - 24), 0.6, 2), 0, b === 0 ? 0.35 : 0.12],
        [tone(midi(chord[(b + 1) % 3] ?? 64), 0.5, 4), 0, 0.12],
        [tone(midi((chord[b % 3] ?? 64) + 12), 0.25, 6), 0.5, 0.06],
      ]
    },
  },
  {
    name: 'waltz-150',
    bpm: 150,
    meter: 3,
    pattern: (b, bar) => {
      const chord = PROGRESSION[bar % 4] ?? [60]
      return b === 0
        ? [
            [tone(midi((chord[0] ?? 60) - 24), 0.8, 2.5), 0, 0.35],
            [kick, 0, 0.3],
          ]
        : chord.map((n): [Voice, number, number] => [tone(midi(n), 0.3, 6), 0, 0.08])
    },
  },
  {
    name: 'funk-ramp-100-116-humanized',
    bpm: 100,
    endBpm: 116,
    meter: 4,
    jitter: 0.015,
    swing: 0.56,
    pattern: (b, bar) => [
      ...(b === 0 ? [[kick, 0, 0.9] as [Voice, number, number]] : []),
      ...(b === 2 ? [[kick, 0.5, 0.7] as [Voice, number, number]] : []),
      ...(b % 2 === 1 ? [[snare, 0, 0.6] as [Voice, number, number]] : []),
      [hat, 0.5, 0.3],
      [hat, 0.25, 0.12],
      [hat, 0.75, 0.12],
      [tone(midi(40 + (bar % 2) * 3), 0.15, 10), 0.75, 0.25],
    ],
  },
  {
    name: 'reggaeton-95-noisy',
    bpm: 95,
    meter: 4,
    noiseDb: -24,
    pattern: (b, bar) => [
      [kick, 0, 0.8],
      [snare, 0.75, 0.45],
      ...(b % 2 === 1 ? [[snare, 0.5, 0.45] as [Voice, number, number]] : []),
      ...(b === 0 ? chordHits(bar, 0.06, 2.2) : []),
    ],
  },
  {
    name: 'offbeat-hats-120',
    bpm: 120,
    meter: 4,
    pattern: (b, bar) => [
      ...(b === 0 ? [[kick, 0, 0.6] as [Voice, number, number]] : []),
      ...(b === 2 ? [[snare, 0, 0.4] as [Voice, number, number]] : []),
      // Loud off-beat hats and stabs: the classic "tracks the and" trap for onset trackers.
      [hat, 0.5, 0.6],
      ...chordHits(bar, 0.05, 0.15).map(([v]): [Voice, number, number] => [v, 0.5, 0.05]),
    ],
  },
]

/** Render a style to stereo samples with its ground truth. */
export const synthesize = (style: Style, seconds: number, seed = 1): SynthTrack => {
  const rnd = rng(seed)
  const n = Math.round(seconds * SYNTH_RATE)
  const buf = new Float32Array(2 * n)
  const beats: number[] = []
  const downbeats: number[] = []
  const lead = 0.5
  let t = lead
  let beat = 0
  const endBpm = style.endBpm ?? style.bpm
  while (t < seconds - 0.5) {
    const bpm = style.bpm + ((endBpm - style.bpm) * t) / seconds
    const period = 60 / bpm
    const inBar = beat % style.meter
    const bar = Math.floor(beat / style.meter)
    beats.push(t)
    if (inBar === 0) downbeats.push(t)
    for (const [voice, offset, gain] of style.pattern(inBar, bar)) {
      // Swing delays the off-beat 8th (offset 0.5) towards the triplet.
      const frac = offset === 0.5 && style.swing ? style.swing : offset
      const j = style.jitter ? (rnd() * 2 - 1) * style.jitter : 0
      voice(buf, Math.round((t + frac * period + j) * SYNTH_RATE), gain, rnd)
    }
    t += period
    beat++
  }
  if (style.noiseDb !== undefined) {
    const amp = 10 ** (style.noiseDb / 20)
    let b0 = 0
    for (let i = 0; i < n; i++) {
      // Brownish noise (room rumble / hiss mix) on both channels.
      b0 = 0.98 * b0 + 0.2 * (rnd() * 2 - 1)
      const v = amp * (b0 + 0.3 * (rnd() * 2 - 1))
      add(buf, i, v)
    }
  }
  let peak = 0
  for (const v of buf) peak = Math.max(peak, Math.abs(v))
  if (peak > 0.95) for (let i = 0; i < buf.length; i++) buf[i] = ((buf[i] ?? 0) * 0.95) / peak
  return { name: style.name, samples: buf, beats, downbeats, bpm: style.bpm, meter: style.meter }
}

/** Write interleaved stereo float samples as a 16-bit PCM WAV. */
export const writeWav = async (file: string, samples: Float32Array, rate = SYNTH_RATE) => {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(2, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 4, 28)
  h.writeUInt16LE(4, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  await writeFile(file, Buffer.concat([h, data]))
}

/**
 * Beat F-measure (mir_eval convention): beats before 5 s are ignored in both lists, a
 * detection matches at most one annotation within ±`window` seconds.
 */
export const fMeasure = (
  reference: readonly number[],
  estimated: readonly number[],
  window = 0.07,
  skip = 5,
): number => {
  const ref = reference.filter((t) => t >= skip)
  const est = estimated.filter((t) => t >= skip)
  if (ref.length === 0 && est.length === 0) return 1
  if (ref.length === 0 || est.length === 0) return 0
  let hits = 0
  let j = 0
  for (const r of ref) {
    while (j < est.length && (est[j] ?? 0) < r - window) j++
    if (j < est.length && Math.abs((est[j] ?? 0) - r) <= window) {
      hits++
      j++
    }
  }
  const p = hits / est.length
  const rc = hits / ref.length
  return p + rc === 0 ? 0 : (2 * p * rc) / (p + rc)
}
