/**
 * Decode planning for frame-accurate seeking with WebCodecs: given where the decoder is,
 * which frames are already decoded and which frame is wanted, decide whether to keep
 * feeding samples, wait for frames already in flight, or restart at a keyframe. Pure so the
 * policy is unit-tested; the decoder wrapper only executes plans.
 *
 * Policy, with `f` = the first frame of the wanted window [target, target + ahead] that is
 * not held yet:
 * - nothing to do when the whole window is held (no reset, nothing fed);
 * - continue the current run when `f` is ahead of the next sample to feed and no keyframe
 *   lies in between (decoding through is then the only way anyway);
 * - wait when `f` was already fed and its output has not arrived yet (decoders emit in
 *   presentation order, so "not out yet" = cts beyond the last output);
 * - restart at `f`'s keyframe when jumping forward past a keyframe (cheaper than decoding
 *   the frames in between), when going backwards to a frame that is no longer held, after
 *   a flush, or after the decoder was reset.
 */
import { keyframeBefore, type SampleTable } from './mp4.ts'

export interface DecodeRun {
  /** Decode index where the current run started (a keyframe); −1 when there is no run. */
  runStart: number
  /** Next decode index to feed. */
  next: number
}

export interface DecodePlan {
  reset: boolean
  /** First decode index to feed (inclusive). */
  from: number
  /** Last decode index to feed (inclusive); < from when nothing needs feeding. */
  to: number
}

/**
 * @param target decode index of the wanted frame
 * @param ahead extra frames wanted decoded past the target (read-ahead / step-ahead)
 * @param isHeld whether the frame at a decode index is decoded and held
 * @param lastOut timestamp (us) of the latest frame output since the last reset, or −∞
 */
export function planDecode(
  s: SampleTable,
  run: DecodeRun,
  target: number,
  ahead: number,
  isHeld: (i: number) => boolean,
  lastOut: number,
  out: DecodePlan = { reset: false, from: 0, to: -1 },
): DecodePlan {
  const last = s.count - 1
  const t = Math.max(0, Math.min(last, target))
  const to = Math.min(last, t + Math.max(0, ahead))
  let f = t
  while (f <= to && isHeld(f)) f++
  out.reset = false
  out.from = run.next
  if (f > to) {
    out.to = -1 // everything wanted is on screen already
    return out
  }
  const key = keyframeBefore(s, f)
  const fed = run.runStart >= 0 && f >= run.runStart && f < run.next
  const inFlight = fed && s.cts[f]! > lastOut
  const restart = run.runStart < 0 || f < run.runStart || (fed && !inFlight) || key > run.next
  out.reset = restart
  out.from = restart ? key : run.next
  out.to = to
  return out
}
