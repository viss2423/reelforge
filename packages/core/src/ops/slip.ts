/**
 * Slip and roll edits.
 *
 * - SLIP moves a clip's content inside its fixed timeline span: the in-point changes, the
 *   clip's position, duration, keyframes, effects and neighbours do not.
 * - ROLL moves the cut between two adjacent main-track clips: the outgoing clip's tail and
 *   the incoming clip's head change by the same amount, so nothing else on the timeline
 *   moves and the total length is unchanged.
 *
 * Both are limited by the available source (in-point ≥ 0, source end ≤ asset duration) and
 * by the one-frame minimum clip duration; the requested amount is clamped and the amount
 * actually applied is returned, so a UI can preview with the same limits (`slipLimits`,
 * `rollLimits`).
 */
import type { Asset, Clip, Project, Us } from '../schema.ts'
import { OpError, clamp, clone } from './errors.ts'
import { assertUnlocked, getClip, minClipDuration } from './project.ts'
import { editMain } from './main.ts'
import { extendClip } from './edit.ts'
import { sliceInPlace } from './slice.ts'
import { sourceSpan, type TimedClip } from './timemap.ts'

/** Asset durations by id (only `duration` is read). */
export type AssetDurations = Readonly<Record<string, Pick<Asset, 'duration'> | undefined>>

const isTimed = (c: Clip): c is Extract<TimedClip, { type: 'video' | 'audio' }> =>
  c.type === 'video' || c.type === 'audio'

const assetDuration = (c: Clip, assets: AssetDurations | undefined): Us | undefined =>
  'assetId' in c && c.assetId ? assets?.[c.assetId]?.duration : undefined

/**
 * Range of SOURCE deltas (µs) a slip may apply: the in-point stays ≥ 0 and the source end
 * stays within the asset (unbounded above when the asset duration is unknown).
 */
export function slipLimits(
  clip: Clip,
  asset: Pick<Asset, 'duration'> | undefined,
): { min: number; max: number } {
  if (!isTimed(clip)) return { min: 0, max: 0 }
  const min = 0 - clip.in
  const total = asset?.duration
  const max = total === undefined ? Infinity : total - (clip.in + sourceSpan(clip))
  return { min, max: Math.max(min, max) }
}

/**
 * Slip a video/audio clip by `delta` µs of SOURCE time (positive shows later source). The
 * amount is clamped to `slipLimits`; returns the applied delta. Main-track captions are
 * re-anchored to the speech they transcribe.
 */
export function slipClip(
  p: Project,
  clipId: string,
  delta: number,
  opts?: { asset?: Pick<Asset, 'duration'> },
): number {
  const { track, clip } = getClip(p, clipId)
  assertUnlocked(track)
  if (!isTimed(clip)) throw new OpError('not_timed', `${clip.type} clips have no source to slip`)
  if (!Number.isFinite(delta)) throw new OpError('invalid_delta', `invalid slip ${delta}`)
  const { min, max } = slipLimits(clip, opts?.asset)
  const d = Math.round(clamp(delta, min, max)) || 0
  if (d === 0) return 0
  const apply = () => {
    clip.in += d
  }
  if (track.kind === 'main') editMain(p, apply)
  else apply()
  return d
}

/** Longest a clip can grow at its head or tail (µs), bounded by `cap` for unbounded media. */
function growRoom(c: Clip, side: 'head' | 'tail', total: Us | undefined, cap: Us): number {
  const probe = clone(c)
  const before = probe.duration
  extendClip(probe, side === 'head' ? cap : 0, side === 'tail' ? cap : 0, total)
  return probe.duration - before
}

/** One hour: the "unbounded" growth limit of stills and clips of unknown length. */
const UNBOUNDED_GROWTH: Us = 3_600_000_000

interface RollPair {
  left: Clip
  right: Clip
}

function rollPair(p: Project, clipId: string): RollPair & { track: Project['tracks'][number] } {
  const { track, clip, index } = getClip(p, clipId)
  if (track.kind !== 'main') {
    throw new OpError('not_main', 'roll edits move a cut between two main-track clips')
  }
  const left = track.clips[index - 1]
  if (!left) throw new OpError('no_previous_clip', `${clipId} is the first clip`)
  return { track, left, right: clip }
}

/**
 * Range of timeline deltas (µs) a roll of the cut INTO main clip `clipId` may apply:
 * negative moves the cut earlier (left clip shorter, right clip reveals earlier source).
 */
export function rollLimits(
  p: Project,
  clipId: string,
  assets?: AssetDurations,
): { min: number; max: number } {
  const { left, right } = rollPair(p, clipId)
  const minDur = minClipDuration(p.settings.fps)
  const leftGrow = growRoom(left, 'tail', assetDuration(left, assets), UNBOUNDED_GROWTH)
  const rightGrow = growRoom(right, 'head', assetDuration(right, assets), UNBOUNDED_GROWTH)
  const min = 0 - Math.max(0, Math.min(left.duration - minDur, rightGrow))
  const max = Math.max(0, Math.min(right.duration - minDur, leftGrow))
  return { min, max }
}

/**
 * Roll the cut between main clip `clipId` and the clip before it by `delta` timeline µs
 * (clamped to `rollLimits`). Returns the applied delta. Both clips keep an exact source
 * mapping; captions are re-anchored.
 */
export function rollEdit(
  p: Project,
  clipId: string,
  delta: number,
  opts?: { assets?: AssetDurations },
): number {
  const { track, left, right } = rollPair(p, clipId)
  assertUnlocked(track)
  if (!Number.isFinite(delta)) throw new OpError('invalid_delta', `invalid roll ${delta}`)
  const { min, max } = rollLimits(p, clipId, opts?.assets)
  const d = Math.round(clamp(delta, min, max)) || 0
  if (d === 0) return 0
  editMain(p, () => {
    if (d > 0) {
      const before = left.duration
      extendClip(left, 0, d, assetDuration(left, opts?.assets))
      const grown = left.duration - before
      sliceInPlace(right, grown, right.duration)
    } else {
      const before = right.duration
      extendClip(right, -d, 0, assetDuration(right, opts?.assets))
      const grown = right.duration - before
      sliceInPlace(left, 0, left.duration - grown)
    }
  })
  return d
}
