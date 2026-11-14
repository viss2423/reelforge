/**
 * Project invariant checks. Returns every problem found (empty array = valid) so the UI can
 * surface them and tests can assert that every op preserves the model's invariants.
 */
import { Project, type Asset, type Clip, type Keyframe } from './schema.ts'
import { MIN_TRANSITION, isMediaClip, minClipDuration, trackAccepts } from './ops/project.ts'
import { sourceSpan } from './ops/timemap.ts'

export type IssueCode =
  | 'schema'
  | 'duplicate_id'
  | 'main_track_count'
  | 'main_track_clip_type'
  | 'main_track_gap'
  | 'track_clip_kind'
  | 'clip_overlap'
  | 'clip_too_short'
  | 'keyframes_unsorted'
  | 'speed_ramp_invalid'
  | 'source_out_of_range'
  | 'asset_missing'
  | 'asset_kind_mismatch'
  | 'transition_on_first'
  | 'transition_too_long'
  | 'effect_out_of_range'
  | 'caption_word_invalid'

export interface Issue {
  code: IssueCode
  message: string
  clipId?: string
  trackId?: string
}

/** Rounding slack (µs) for source spans computed through floating-point ramp integrals. */
const SOURCE_EPSILON = 1

function checkKeyframes(
  keyframes: readonly Keyframe[],
  what: string,
  clip: Clip,
  trackId: string,
  issues: Issue[],
): void {
  for (let i = 1; i < keyframes.length; i++) {
    if (keyframes[i]!.t <= keyframes[i - 1]!.t) {
      issues.push({
        code: 'keyframes_unsorted',
        message: `${what} keyframes of ${clip.id} are not strictly increasing`,
        clipId: clip.id,
        trackId,
      })
      return
    }
  }
}

/** Largest ease() value of the overshooting easings (easeOutBack ≈ 1.1, elastic ≈ 1.3731). */
const OVERSHOOT: Partial<Record<Keyframe['easing'], number>> = {
  easeOutBack: 1.10001,
  easeOutElastic: 1.37311,
}

/**
 * A speed ramp must stay strictly positive everywhere (the source integral must be strictly
 * increasing), including where an overshooting easing dips below its target value.
 */
function rampStaysPositive(ramp: readonly Keyframe[]): boolean {
  for (let i = 0; i < ramp.length; i++) {
    const k = ramp[i]!
    if (!(k.value > 0)) return false
    const prev = ramp[i - 1]
    const over = OVERSHOOT[k.easing]
    if (prev && over !== undefined && !(prev.value + (k.value - prev.value) * over > 0)) {
      return false
    }
  }
  return true
}

/** Check every invariant of the model; `assets` enables source-range/asset checks. */
export function validateProject(p: Project, assets?: Readonly<Record<string, Asset>>): Issue[] {
  const issues: Issue[] = []
  const parsed = Project.safeParse(p)
  if (!parsed.success) {
    for (const e of parsed.error.issues.slice(0, 20)) {
      issues.push({ code: 'schema', message: `${e.path.join('.')}: ${e.message}` })
    }
    return issues
  }

  const mains = p.tracks.filter((t) => t.kind === 'main')
  if (mains.length !== 1) {
    issues.push({
      code: 'main_track_count',
      message: `expected 1 main track, found ${mains.length}`,
    })
  }

  const ids = new Set<string>()
  const seen = (id: string, trackId?: string, clipId?: string) => {
    if (ids.has(id)) {
      issues.push({
        code: 'duplicate_id',
        message: `duplicate id ${id}`,
        ...(trackId !== undefined && { trackId }),
        ...(clipId !== undefined && { clipId }),
      })
    }
    ids.add(id)
  }

  const minDuration = minClipDuration(p.settings.fps)
  for (const track of p.tracks) {
    seen(track.id, track.id)
    let cursor = 0
    let prevDuration: number | undefined
    const sorted =
      track.kind === 'main' ? track.clips : track.clips.toSorted((a, b) => a.start - b.start)
    sorted.forEach((clip, index) => {
      const at = { clipId: clip.id, trackId: track.id }
      seen(clip.id, track.id, clip.id)
      if (!trackAccepts(track.kind, clip.type)) {
        issues.push({
          code: track.kind === 'main' ? 'main_track_clip_type' : 'track_clip_kind',
          message: `${clip.type} clip ${clip.id} on ${track.kind} track`,
          ...at,
        })
      }
      if (clip.duration < minDuration) {
        issues.push({
          code: 'clip_too_short',
          message: `${clip.id} is shorter than a frame`,
          ...at,
        })
      }
      if (track.kind === 'main') {
        if (clip.start !== cursor) {
          issues.push({
            code: 'main_track_gap',
            message: `${clip.id} starts at ${clip.start}, expected ${cursor}`,
            ...at,
          })
        }
        cursor += clip.duration
      } else if (index > 0) {
        const prev = sorted[index - 1]!
        if (prev.start + prev.duration > clip.start) {
          issues.push({ code: 'clip_overlap', message: `${clip.id} overlaps ${prev.id}`, ...at })
        }
      }

      if (clip.type !== 'audio') {
        for (const key of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) {
          checkKeyframes(clip.transform[key].keyframes, key, clip, track.id, issues)
        }
      }

      if (isMediaClip(clip)) {
        checkKeyframes(clip.speedRamp, 'speedRamp', clip, track.id, issues)
        if (!rampStaysPositive(clip.speedRamp)) {
          issues.push({
            code: 'speed_ramp_invalid',
            message: `speed ramp of ${clip.id} must stay > 0`,
            ...at,
          })
        }
        if (clip.transitionIn) {
          if (track.kind !== 'main' || index === 0) {
            issues.push({
              code: 'transition_on_first',
              message: `${clip.id} has a transition but no previous main clip`,
              ...at,
            })
          } else if (
            clip.transitionIn.duration < MIN_TRANSITION ||
            clip.transitionIn.duration > Math.floor(clip.duration / 2) ||
            clip.transitionIn.duration > Math.floor((prevDuration ?? 0) / 2)
          ) {
            issues.push({
              code: 'transition_too_long',
              message: `transition into ${clip.id} exceeds half of a neighbouring clip`,
              ...at,
            })
          }
        }
        for (const e of clip.effects) {
          if (
            e.start >= clip.duration ||
            (e.duration !== undefined && e.start + e.duration > clip.duration)
          ) {
            issues.push({
              code: 'effect_out_of_range',
              message: `effect ${e.id} of ${clip.id} exceeds the clip`,
              ...at,
            })
          }
        }
      }

      const assetId = clip.type === 'text' ? undefined : clip.assetId
      if (assets && assetId !== undefined) {
        const asset = assets[assetId]
        if (!asset) {
          issues.push({ code: 'asset_missing', message: `asset ${assetId} not found`, ...at })
        } else {
          const ok =
            clip.type === 'audio'
              ? asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio)
              : clip.type === 'sticker'
                ? asset.kind === 'image'
                : asset.kind === clip.type
          if (!ok) {
            issues.push({
              code: 'asset_kind_mismatch',
              message: `${clip.type} clip ${clip.id} uses ${asset.kind} asset ${asset.id}`,
              ...at,
            })
          } else if (
            (clip.type === 'video' || clip.type === 'audio') &&
            asset.duration !== undefined &&
            clip.in + sourceSpan(clip) > asset.duration + SOURCE_EPSILON
          ) {
            issues.push({
              code: 'source_out_of_range',
              message: `${clip.id} reads past the end of ${asset.id}`,
              ...at,
            })
          }
        }
      }
      prevDuration = clip.duration
    })
  }

  for (const m of p.markers) seen(m.id)

  const words = p.captions?.words ?? []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w.end < w.start || (i > 0 && w.start < words[i - 1]!.start)) {
      issues.push({
        code: 'caption_word_invalid',
        message: `caption word ${i} ("${w.text}") is out of order or has negative length`,
      })
      break
    }
  }
  return issues
}
