/**
 * Auto Edit assembler: turns chosen moments (source ranges in story order) plus a style
 * into a finished timeline, in place, so the caller can wrap it in ONE undoable dispatch:
 *
 *   main track = the moments in order (each clip keeps the look of the user's existing clip
 *   of that asset), look filter + transitions from the style → music at 0 (inserted when
 *   given as an asset), its cut points synced to the beat, faded out, ducked under speech →
 *   captions mapped through the new cuts → hook text over the opening moment.
 *
 * Analysis (transcripts, beats, ranking) is the caller's job; this is pure data in → data out.
 * A music ASSET is placed with `insertMusicClip` (chorus entry, fades, beat/bar markers, one
 * music bed); cuts land on bars when the track has a clear downbeat grid.
 */
import type {
  Asset,
  AudioClip,
  CaptionStyle,
  FilterRef,
  MediaClip,
  Project,
  TextAnimation,
  TextStyle,
  TransitionType,
  Us,
  Word,
} from '../schema.ts'
import { buildCaptions } from './captions.ts'
import { syncToBeats, type BeatSyncOptions } from './beats.ts'
import { clone, OpError } from './errors.ts'
import { insertMediaClip, insertTextClip } from './insert.ts'
import { insertMusicClip } from './music.ts'
import { normalizeMainTrack } from './main.ts'
import { mainTrack, mainTrackLayout, minClipDuration, projectDuration } from './project.ts'
import { sourceToTimeline } from './timemap.ts'

export interface AutoEditMoment {
  assetId: string
  /** Source range (µs). Images use `end - start` as their on-screen time. */
  start: Us
  end: Us
  role?: 'hook' | 'value' | 'payoff'
}

export interface AutoEditPlan {
  moments: readonly AutoEditMoment[]
  /** Look applied to every clip. */
  filter?: FilterRef
  /** Transition into every `every`-th clip after the hook (default every clip). */
  transition?: { type: TransitionType; duration: Us; every?: number }
  music?: {
    /** Existing audio clip to use … */
    clipId?: string
    /** … or an asset to insert at 0. */
    asset?: Asset
    /** Source in-point (start at the energetic section). */
    in?: Us
    /** Beat times in the music's SOURCE time. */
    beats?: readonly Us[]
    /** Bar starts in the music's SOURCE time (from the beat tracker). */
    downbeats?: readonly Us[]
    /**
     * Cut on every beat (1), half bar (2) or bar (4). With a clear downbeat grid, 4 cuts on
     * the real bar starts and 2 is phase-aligned to them.
     */
    every?: 1 | 2 | 4
    volume?: number
    /** Lower the music under speech. */
    duck?: boolean
  }
  captions?: {
    transcripts: Readonly<Record<string, readonly Word[]>>
    style: CaptionStyle
    styleRef?: string
    language?: string
  }
  hookText?: {
    text: string
    style?: Partial<TextStyle>
    presetRef?: string
    animationIn?: TextAnimation
    animationOut?: TextAnimation
    /** Default: the opening moment's length, 1.5–4 s. */
    duration?: Us
  }
}

export interface AutoEditStats {
  clips: number
  duration: Us
  beatSynced: boolean
  captionWords: number
  hookText: boolean
  musicClipId?: string
  /** Grid the cuts were synced to. */
  beatUnit?: 'beat' | 'bar'
}

const MUSIC_FADE_OUT: Us = 1_200_000
const HOOK_TEXT_MIN: Us = 1_500_000
const HOOK_TEXT_MAX: Us = 4_000_000

/**
 * True when `downbeats` form a usable bar grid over `beats`: at least four bars whose
 * spacing is steady (most bars within 15 % of the median bar length) and spans 2–8 beats.
 */
export function hasClearDownbeats(beats: readonly Us[], downbeats: readonly Us[]): boolean {
  if (downbeats.length < 4 || beats.length < 8) return false
  const bars = downbeats.slice(1).map((t, i) => t - downbeats[i]!)
  const sorted = bars.toSorted((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  if (median <= 0) return false
  const steady = bars.filter((b) => Math.abs(b - median) <= median * 0.15).length
  if (steady / bars.length < 0.75) return false
  const beatGaps = beats
    .slice(1)
    .map((t, i) => t - beats[i]!)
    .toSorted((a, b) => a - b)
  const beat = beatGaps[Math.floor(beatGaps.length / 2)]!
  const perBar = beat > 0 ? median / beat : 0
  return perBar >= 1.75 && perBar <= 8.5
}

/** Sync options for a plan's music: bars when the downbeats are trustworthy. */
export function musicSyncOptions(
  every: 1 | 2 | 4,
  beats: readonly Us[],
  downbeats: readonly Us[],
): Omit<BeatSyncOptions, 'trackId'> {
  if (!hasClearDownbeats(beats, downbeats)) return { every }
  return every === 4 ? { unit: 'bar', every: 1, downbeats } : { unit: 'beat', every, downbeats }
}

/** Clip properties that carry over from the user's clip of the same asset. */
const carryOver = (from: MediaClip, to: MediaClip): void => {
  to.fit = from.fit
  to.crop = clone(from.crop)
  to.adjustments = clone(from.adjustments)
  to.audio = { ...clone(from.audio), fadeIn: 0, fadeOut: 0 }
  to.effects = []
  to.blendMode = from.blendMode
  if (from.chromaKey) to.chromaKey = clone(from.chromaKey)
  if (from.filter) to.filter = clone(from.filter)
  // Keyframed transforms (e.g. a reframe path) are tied to the old source window.
  const t = from.transform
  const animated = [t.x, t.y, t.scale, t.rotation, t.opacity].some((a) => a.keyframes.length > 0)
  if (!animated) to.transform = clone(t)
}

/** Builds the timeline from `plan`. Throws OpError when no moment can be placed. */
export function assembleAutoEdit(
  p: Project,
  plan: AutoEditPlan,
  assets: Readonly<Record<string, Asset>>,
): AutoEditStats {
  const main = mainTrack(p)
  if (main.locked) throw new OpError('locked', 'The main track is locked')
  const min = minClipDuration(p.settings.fps)
  const templates = new Map<string, MediaClip>()
  for (const c of main.clips)
    if ((c.type === 'video' || c.type === 'image') && !templates.has(c.assetId))
      templates.set(c.assetId, clone(c))

  // 1. Main track: the moments, in order.
  main.clips = []
  for (const m of plan.moments) {
    const asset = assets[m.assetId]
    if (!asset || asset.kind === 'audio') continue
    const span = Math.max(0, m.end - m.start)
    if (span < min) continue
    if (asset.kind === 'video') {
      const total = asset.duration ?? 0
      const start = Math.min(m.start, Math.max(0, total - min))
      const dur = Math.min(span, total - start)
      if (dur < min) continue
      const clip = insertMediaClip(p, {
        trackId: main.id,
        asset,
        index: main.clips.length,
        duration: dur,
      })
      clip.in = start
      const tpl = templates.get(asset.id)
      if (tpl?.type === 'video') carryOver(tpl, clip)
    } else {
      const clip = insertMediaClip(p, {
        trackId: main.id,
        asset,
        index: main.clips.length,
        duration: span,
      })
      const tpl = templates.get(asset.id)
      if (tpl) carryOver(tpl, clip)
      clip.autoMotion = tpl?.autoMotion !== 'none' && tpl ? tpl.autoMotion : 'zoomIn'
    }
  }
  if (!main.clips.length) throw new OpError('empty', 'None of the chosen moments could be placed')

  // 2. Look: filter + transitions.
  main.clips.forEach((c, i) => {
    if (c.type !== 'video' && c.type !== 'image') return
    if (plan.filter) c.filter = clone(plan.filter)
    delete c.transitionIn
    const t = plan.transition
    // The hook → first moment cut stays hard: it is the beat the viewer is hooked on.
    if (t && i >= 2 && (i - 1) % Math.max(1, t.every ?? 1) === 0)
      c.transitionIn = { type: t.type, duration: t.duration }
  })
  normalizeMainTrack(p)

  // 3. Music at 0, cuts on the beat.
  let musicClip: AudioClip | undefined
  let beatSynced = false
  const music = plan.music
  if (music) {
    if (music.clipId) {
      for (const t of p.tracks)
        for (const c of t.clips) if (c.id === music.clipId && c.type === 'audio') musicClip = c
      if (!musicClip) throw new OpError('no_music', 'The music clip was removed')
    } else if (music.asset) {
      musicClip = insertMusicClip(p, {
        asset: music.asset,
        ...(music.in !== undefined ? { sourceStart: music.in } : {}),
        duck: music.duck ?? false,
        ...(music.beats ? { beats: music.beats } : {}),
        ...(music.downbeats ? { downbeats: music.downbeats } : {}),
      })
    }
  }
  let beatUnit: AutoEditStats['beatUnit']
  if (musicClip && music) {
    if (music.clipId) {
      const assetDur = assets[musicClip.assetId]?.duration ?? musicClip.in + musicClip.duration
      const full = Math.round(Math.max(0, assetDur - (music.in ?? musicClip.in)) / musicClip.speed)
      if (music.in !== undefined) musicClip.in = Math.max(0, Math.min(music.in, assetDur - min))
      musicClip.start = 0
      musicClip.duration = Math.max(min, Math.min(full || musicClip.duration, assetDur))
    }
    if (music.volume !== undefined) musicClip.audio.volume = music.volume
    if (music.duck !== undefined) musicClip.duckUnderVoice = music.duck
    // Other clips on the music's track must not overlap it.
    const owner = p.tracks.find((t) => t.clips.includes(musicClip!))
    if (owner)
      owner.clips = owner.clips.filter((c) => c === musicClip || c.start >= musicClip!.duration)
    if (music.beats?.length) {
      const toTimeline = (src: readonly Us[]): Us[] =>
        src
          .map((b) => sourceToTimeline(musicClip!, b))
          .filter((t): t is Us => t !== undefined && t > 0)
          .map(Math.round)
      const beats = toTimeline(music.beats)
      if (beats.length) {
        const opts = musicSyncOptions(music.every ?? 1, beats, toTimeline(music.downbeats ?? []))
        syncToBeats(p, beats, opts)
        beatSynced = true
        beatUnit = opts.unit ?? 'beat'
      }
    }
    const total = mainTrackLayout(p).at(-1)?.end ?? 0
    if (musicClip.duration > total) musicClip.duration = Math.max(min, total)
    musicClip.audio.fadeOut = Math.min(MUSIC_FADE_OUT, Math.floor(musicClip.duration / 2))
  }

  // 4. Captions through the final cuts.
  let captionWords = 0
  if (plan.captions) {
    const words = Object.values(plan.captions.transcripts).reduce((n, w) => n + w.length, 0)
    if (words > 0) {
      buildCaptions(p, plan.captions.transcripts, plan.captions.style, {
        ...(plan.captions.styleRef !== undefined && { styleRef: plan.captions.styleRef }),
        ...(plan.captions.language !== undefined && { language: plan.captions.language }),
      })
      captionWords = p.captions?.words.length ?? 0
    }
  }

  // 5. Hook text over the opening moment.
  let hookText = false
  const h = plan.hookText
  if (h && h.text.trim()) {
    const first = mainTrackLayout(p)[0]
    const opening = first ? first.end - first.start : HOOK_TEXT_MAX
    const duration = Math.max(
      min,
      Math.min(
        h.duration ?? Math.max(HOOK_TEXT_MIN, Math.min(HOOK_TEXT_MAX, opening)),
        projectDuration(p),
      ),
    )
    const clip = insertTextClip(p, {
      at: 0,
      duration,
      text: h.text.trim(),
      ...(h.style ? { style: h.style } : {}),
      ...(h.presetRef !== undefined ? { presetRef: h.presetRef } : {}),
    })
    // Upper third: captions sit lower, faces usually in the middle.
    clip.transform.y.value = 480
    if (h.animationIn)
      clip.animationIn = {
        ...h.animationIn,
        duration: Math.min(h.animationIn.duration, Math.floor(duration / 2)),
      }
    if (h.animationOut)
      clip.animationOut = {
        ...h.animationOut,
        duration: Math.min(h.animationOut.duration, Math.floor(duration / 2)),
      }
    hookText = true
  }

  return {
    clips: main.clips.length,
    duration: projectDuration(p),
    beatSynced,
    captionWords,
    hookText,
    ...(musicClip ? { musicClipId: musicClip.id } : {}),
    ...(beatUnit ? { beatUnit } : {}),
  }
}
