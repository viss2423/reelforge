/**
 * Pure scheduling logic for the WebAudio engine: which source pieces to start in a look-ahead
 * window (exactly once each, even when their buffers finish decoding late), how to map
 * timeline time onto the AudioContext timeline, and the gain automation breakpoints of a
 * voice (volume × fades × ducking).
 */
import {
  DUCK_ATTACK_US,
  DUCK_RELEASE_US,
  duckFactorAt,
  planPieces,
  voiceGainAt,
  type Interval,
  type Piece,
  type Voice,
} from './voices.ts'

/** A piece ready to be started as an AudioBufferSourceNode. */
export interface PieceStart {
  /** Index into the voices array. */
  voice: number
  seg: number
  /** Timeline time (us) at which it starts sounding. */
  when: number
  /** Source range [srcStart, srcEnd) in us (played backwards for reversed voices). */
  srcStart: number
  srcEnd: number
}

/** Pieces shorter than this (us) are not worth a node (avoids clicks from slivers). */
const MIN_PIECE_US = 2_000

export class PiecePlanner {
  readonly #scheduled = new Set<string>()
  readonly #pieces: Piece[] = []

  /** Forget everything scheduled (seek / stop / project change). */
  reset(): void {
    this.#scheduled.clear()
  }

  get scheduledCount(): number {
    return this.#scheduled.size
  }

  /**
   * Collect pieces that start before `to` and still have audio after `from`, that were not
   * scheduled yet and whose buffer is ready. A piece whose buffer arrived late is trimmed
   * to start at `from` (we never start sound in the past). Returns the count written.
   *
   * @param segOf segment length (us) of a voice's asset, or undefined while unknown
   * @param ready whether segment `seg` of the voice's asset is decoded (in its direction)
   */
  plan(
    voices: readonly Voice[],
    from: number,
    to: number,
    segOf: (v: Voice) => number | undefined,
    ready: (v: Voice, seg: number) => boolean,
    out: PieceStart[],
  ): number {
    let n = 0
    const pieces = this.#pieces
    for (let vi = 0; vi < voices.length; vi++) {
      const v = voices[vi]!
      if (v.end <= from || v.start >= to) continue
      const seg = segOf(v)
      if (seg === undefined) continue
      // plan to the END of the voice so each segment's piece is whole (window-independent)
      const count = planPieces(v, from, v.end, seg, pieces)
      for (let i = 0; i < count; i++) {
        const p = pieces[i]!
        if (p.when >= to) break
        // a voice maps time monotonically, so each segment occurs once per voice
        const key = `${v.clipId}|${p.seg}`
        if (this.#scheduled.has(key) || !ready(v, p.seg)) continue
        let { srcStart, srcEnd, when } = p
        if (when < from) {
          const skip = (from - when) * v.speed
          if (v.reverse) srcEnd -= skip
          else srcStart += skip
          when = from
        }
        if (srcEnd - srcStart < MIN_PIECE_US) continue
        this.#scheduled.add(key)
        const o = out[n] ?? (out[n] = { voice: 0, seg: 0, when: 0, srcStart: 0, srcEnd: 0 })
        o.voice = vi
        o.seg = p.seg
        o.when = when
        o.srcStart = srcStart
        o.srcEnd = srcEnd
        n++
      }
    }
    return n
  }
}

/** Linear map between timeline us and AudioContext seconds, anchored at play/seek. */
export interface AudioAnchor {
  /** Timeline time (us) that sounds at `ctxTime`. */
  t: number
  ctxTime: number
}

export const toCtxTime = (a: AudioAnchor, t: number): number => a.ctxTime + (t - a.t) / 1e6
export const toTimeline = (a: AudioAnchor, ctxTime: number): number =>
  a.t + (ctxTime - a.ctxTime) * 1e6

/**
 * Gain automation for voice `v` over timeline window [from, to]: flattened (t, gain) pairs
 * at every point where the envelope changes slope (fade and duck corners), so chaining
 * `linearRampToValueAtTime` through them reproduces the envelope exactly (except where a
 * fade and a duck ramp overlap, where the product is approximated linearly).
 * Evaluation is clamped inside the voice, so no ramp ever heads to the silent 0 outside it.
 * Writes into `out` (reused) and returns the number of PAIRS.
 */
export function gainBreakpoints(
  v: Voice,
  duck: readonly Interval[] | null,
  from: number,
  to: number,
  out: number[],
): number {
  const a = Math.max(from, v.start)
  const b = Math.min(to, v.end)
  out.length = 0
  if (b < a) return 0
  const ts: number[] = [a, b]
  const add = (t: number): void => {
    if (t > a && t < b) ts.push(t)
  }
  add(v.start + v.fadeIn)
  add(v.end - v.fadeOut)
  if (duck && v.duck) {
    for (const iv of duck) {
      if (iv.start > b) break
      add(iv.start)
      add(iv.start + DUCK_ATTACK_US)
      add(iv.end)
      add(iv.end + DUCK_RELEASE_US)
    }
  }
  ts.sort((x, y) => x - y)
  let prev = Number.NaN
  for (const t of ts) {
    if (t === prev) continue
    prev = t
    const te = Math.min(Math.max(t, v.start), v.end - 1)
    const g = voiceGainAt(v, te) * (duck && v.duck ? duckFactorAt(duck, te) : 1)
    out.push(t, g)
  }
  return out.length / 2
}
