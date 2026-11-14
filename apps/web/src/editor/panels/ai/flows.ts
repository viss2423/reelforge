/**
 * AI editing flows. Each flow (1) works out which assets to analyse, (2) runs the host jobs
 * (or reuses analysis cached on the asset), then (3) applies the result to the project as
 * ONE `dispatch` — a single undo step, recorded against whatever the project is at that
 * moment (analysis is per asset, so edits made while the host worked are respected).
 */
import {
  applyReframe,
  buildCaptions,
  newId,
  OpError,
  removeSourceRanges,
  sourceToTimeline,
  splitClip,
  syncToBeats,
  type Asset,
  type AudioClip,
  type CaptionStyle,
  type MediaClip,
  type Project,
  type Range,
  type Us,
  type Word,
} from '@reelforge/core'
import type { EditorStoreApi } from '@/state/editorStore.ts'
import { allClips, hasAudio, isAudioClip, isVideo, locate, mainMediaClips } from '../model/draft.ts'
import { clipRanges, fillerRanges, mergeRanges, overlapLength } from '../model/ranges.ts'
import { runJobs, type JobDeps, type JobInput } from './jobs.ts'
import { readBeats, readReframe, readScenes, readSilence, readTranscript } from './results.ts'

export interface FlowContext {
  store: EditorStoreApi
  jobs: JobDeps
  signal: AbortSignal
  /** Overall progress 0..1 with a short status line. */
  report: (progress: number, label: string) => void
}

/** Per-asset source ranges to cut. */
export type CutRanges = Record<string, Range[]>

export interface CutPlan {
  ranges: CutRanges
  /** Clip kinds the cut applies to: silence → main track; fillers → main + voiceover. */
  scope: 'main' | 'speech'
}

export interface CutStats {
  /** Number of separate cuts across clips. */
  count: number
  /** Timeline time removed (µs). */
  removed: Us
}

/* ------------------------------------------------------------------ sources */

const projectOf = (store: EditorStoreApi): Project => {
  const p = store.getState().project
  if (!p) throw new OpError('no_project', 'No project open')
  return p
}

const audible = (store: EditorStoreApi, assetId: string): boolean =>
  store.getState().assets[assetId]?.hasAudio !== false

/** Main-track video clips whose media carries audio. */
const mainSpeechClips = (p: Project, store: EditorStoreApi): MediaClip[] =>
  mainMediaClips(p).filter((c) => isVideo(c) && audible(store, c.assetId))

/** Clips whose speech becomes captions: main + overlay video, and voiceovers. */
const speechClips = (p: Project, store: EditorStoreApi): Array<MediaClip | AudioClip> => {
  const out: Array<MediaClip | AudioClip> = []
  for (const t of p.tracks) {
    if (t.muted) continue
    for (const c of t.clips) {
      if (isVideo(c) && (t.kind === 'main' || t.kind === 'overlay') && audible(store, c.assetId))
        out.push(c)
      else if (isAudioClip(c) && c.role === 'voiceover') out.push(c)
    }
  }
  return out
}

const distinct = (clips: readonly { assetId: string }[]): string[] => [
  ...new Set(clips.map((c) => c.assetId)),
]

/** Clips a cut plan touches in `p`. */
const cutTargets = (p: Project, store: EditorStoreApi, scope: CutPlan['scope']) =>
  scope === 'main'
    ? mainSpeechClips(p, store)
    : speechClips(p, store).filter((c) => {
        const loc = locate(p, c.id)
        return loc?.track.kind === 'main' || isAudioClip(c)
      })

/** Source window [in, in + span) a clip plays. Speed curves keep the span (mean 1). */
const sourceWindow = (c: MediaClip | AudioClip): [Us, Us] => [
  c.in,
  c.in + Math.round(c.duration * c.speed),
]

/* ------------------------------------------------------------------ analysis */

interface Analysis<T> {
  results: Record<string, T>
}

/**
 * Runs one job kind for each asset, skipping assets whose cached analysis `cached` returns.
 * Progress maps onto [from, to] of the flow's bar.
 */
const analyze = async <T>(
  ctx: FlowContext,
  assetIds: readonly string[],
  job: (assetId: string) => JobInput,
  read: (result: unknown) => T,
  cached: (asset: Asset | undefined) => T | undefined,
  label: string,
  [from, to]: [number, number] = [0, 1],
): Promise<Analysis<T>> => {
  const results: Record<string, T> = {}
  const pending: string[] = []
  const assets = ctx.store.getState().assets
  for (const id of assetIds) {
    const hit = cached(assets[id])
    if (hit !== undefined) results[id] = hit
    else pending.push(id)
  }
  ctx.report(from, label)
  const jobs = await runJobs(ctx.jobs, pending.map(job), {
    signal: ctx.signal,
    onProgress: (p) => ctx.report(from + (to - from) * p, label),
  })
  jobs.forEach((j, i) => {
    results[pending[i]!] = read(j.result)
  })
  return { results }
}

const transcribeJob =
  (projectId: string, language: string) =>
  (assetId: string): JobInput => ({
    kind: 'transcribe',
    assetId,
    projectId,
    payload: language === 'auto' ? { assetId } : { assetId, language },
  })

const cachedTranscript = (language: string) => (a: Asset | undefined) =>
  language === 'auto' && a?.transcript ? a.transcript : undefined

const transcribe = (
  ctx: FlowContext,
  assetIds: string[],
  language: string,
  span?: [number, number],
) =>
  analyze<Word[]>(
    ctx,
    assetIds,
    transcribeJob(projectOf(ctx.store).id, language),
    (r) => readTranscript(r).words,
    cachedTranscript(language),
    'Transcribing speech',
    span,
  )

export interface SilenceOptions {
  /** Fixed threshold (dBFS); default adaptive on the host. */
  thresholdDb?: number
  /** Shortest pause to cut (µs). */
  minSilence?: Us
  /** Breath kept around speech (µs). */
  padding?: Us
}

const silenceJob =
  (projectId: string, o: SilenceOptions) =>
  (assetId: string): JobInput => ({
    kind: 'silence',
    assetId,
    projectId,
    payload: { assetId, ...o },
  })

/* ------------------------------------------------------------------ cuts */

/** Stats a cut plan would have on project `p` (for the "saves 8.4 s" preview). */
export const cutStats = (p: Project, store: EditorStoreApi, plan: CutPlan): CutStats => {
  let count = 0
  let removed = 0
  for (const c of cutTargets(p, store, plan.scope)) {
    const ranges = plan.ranges[c.assetId]
    if (!ranges?.length) continue
    const [lo, hi] = sourceWindow(c)
    const inside = clipRanges(ranges, lo, hi)
    count += inside.length
    removed += overlapLength(inside, lo, hi) / c.speed
  }
  return { count, removed: Math.round(removed) }
}

/** Applies per-asset cuts to every targeted clip of the draft (call inside a recipe). */
const applyCuts = (d: Project, store: EditorStoreApi, plan: CutPlan): void => {
  // Resolve targets first: cutting splits clips into new ids.
  const targets = cutTargets(d, store, plan.scope).map((c) => c.id)
  for (const id of targets) {
    const c = locate(d, id)?.clip
    if (!hasAudio(c)) continue
    const ranges = plan.ranges[c.assetId]
    if (!ranges?.length) continue
    const [lo, hi] = sourceWindow(c)
    const inside = clipRanges(ranges, lo, hi)
    if (inside.length) removeSourceRanges(d, id, inside)
  }
}

/** Detects silences on the main track's audio. */
export const planSilence = async (ctx: FlowContext, o: SilenceOptions = {}): Promise<CutPlan> => {
  const p = projectOf(ctx.store)
  const assets = distinct(mainSpeechClips(p, ctx.store))
  if (!assets.length)
    throw new OpError('no_audio', 'Add a video with sound to the main track first')
  const { results } = await analyze(
    ctx,
    assets,
    silenceJob(p.id, o),
    readSilence,
    () => undefined,
    'Finding silences',
  )
  const ranges: CutRanges = {}
  for (const [id, r] of Object.entries(results)) ranges[id] = mergeRanges(r)
  return { ranges, scope: 'main' }
}

/** Finds filler words ("um", "uh"…) in the main track and voiceovers. */
export const planFillers = async (ctx: FlowContext, language = 'auto'): Promise<CutPlan> => {
  const p = projectOf(ctx.store)
  const assets = distinct(cutTargets(p, ctx.store, 'speech'))
  if (!assets.length) throw new OpError('no_audio', 'There is no speech to clean up')
  const { results } = await transcribe(ctx, assets, language)
  const ranges: CutRanges = {}
  for (const [id, words] of Object.entries(results)) ranges[id] = fillerRanges(words)
  return { ranges, scope: 'speech' }
}

/** Applies a cut plan as one undo step; returns what it removed. */
export const applyCutPlan = (store: EditorStoreApi, plan: CutPlan, label: string): CutStats => {
  const stats = cutStats(projectOf(store), store, plan)
  if (stats.count === 0) return stats
  store.getState().dispatch(label, (d) => applyCuts(d, store, plan))
  return stats
}

/* ------------------------------------------------------------------ captions */

export interface CaptionOptions {
  style: CaptionStyle
  styleRef?: string
  language: string
}

/** Transcribes every speech source and builds captions with `style`. Returns the word count. */
export const autoCaptions = async (ctx: FlowContext, o: CaptionOptions): Promise<number> => {
  const p = projectOf(ctx.store)
  const assets = distinct(speechClips(p, ctx.store))
  if (!assets.length) throw new OpError('no_audio', 'Add a clip with speech first')
  const { results } = await transcribe(ctx, assets, o.language, [0, 0.95])
  const total = Object.values(results).reduce((n, w) => n + w.length, 0)
  if (total === 0) throw new OpError('no_speech', 'No speech was found in this video')
  ctx.report(0.97, 'Building captions')
  return ensureSameProject(ctx, p.id, () =>
    ctx.store.getState().dispatch('Auto captions', (d) => {
      buildCaptions(d, results, o.style, captionOpts(o))
      return d.captions?.words.length ?? 0
    }),
  )
}

const captionOpts = (o: CaptionOptions) => ({
  language: o.language,
  ...(o.styleRef ? { styleRef: o.styleRef } : {}),
})

const ensureSameProject = <R>(ctx: FlowContext, projectId: string, fn: () => R): R => {
  if (ctx.signal.aborted) throw ctx.signal.reason as Error
  if (ctx.store.getState().project?.id !== projectId)
    throw new OpError('project_changed', 'The project was closed before the result arrived')
  return fn()
}

/* ------------------------------------------------------------------ beats */

/** Maps beats (music source time) onto the timeline through the music clip. */
export const timelineBeats = (clip: AudioClip, beats: readonly Us[]): Us[] => {
  const out: Us[] = []
  for (const b of beats) {
    const t = sourceToTimeline(clip, b)
    if (t !== undefined) out.push(Math.round(t))
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/** Replaces beat markers and re-times main-track cuts to the beats (call inside a recipe). */
const applyBeats = (
  d: Project,
  musicClipId: string,
  beats: readonly Us[],
  every: 1 | 2 | 4,
): number => {
  const clip = locate(d, musicClipId)?.clip
  if (!isAudioClip(clip)) throw new OpError('no_music', 'The music clip was removed')
  const times = timelineBeats(clip, beats)
  if (!times.length) throw new OpError('no_beats', 'No beats fall inside the music clip')
  d.markers = [
    ...d.markers.filter((m) => m.kind !== 'beat'),
    ...times.map((t) => ({ id: newId('m'), t, kind: 'beat' as const })),
  ]
  syncToBeats(d, times, { every })
  return times.length
}

const beatsJob =
  (projectId: string) =>
  (assetId: string): JobInput => ({
    kind: 'beats',
    assetId,
    projectId,
    payload: { assetId },
  })

const cachedBeats = (a: Asset | undefined) => (a?.beats?.length ? a.beats : undefined)

/** Music clips (audio clips with the music role), longest first. */
export const musicClips = (p: Project): AudioClip[] =>
  allClips(p, isAudioClip)
    .map((x) => x.clip)
    .filter((c) => c.role === 'music')
    .sort((a, b) => b.duration - a.duration)

/** Detects the beats of a music clip and cuts the main track on them. Returns beats used. */
export const beatSync = async (
  ctx: FlowContext,
  o: { musicClipId: string; every: 1 | 2 | 4 },
): Promise<number> => {
  const p = projectOf(ctx.store)
  const clip = locate(p, o.musicClipId)?.clip
  if (!isAudioClip(clip)) throw new OpError('no_music', 'Choose a music clip first')
  const { results } = await analyze(
    ctx,
    [clip.assetId],
    beatsJob(p.id),
    (r) => readBeats(r).beats,
    cachedBeats,
    'Detecting beats',
    [0, 0.95],
  )
  const beats = results[clip.assetId] ?? []
  return ensureSameProject(ctx, p.id, () =>
    ctx.store.getState().dispatch('Beat sync', (d) => applyBeats(d, o.musicClipId, beats, o.every)),
  )
}

/* ------------------------------------------------------------------ scenes */

/** Splits main-track video clips at detected scene changes. Returns the number of splits. */
export const splitScenes = async (ctx: FlowContext): Promise<number> => {
  const p = projectOf(ctx.store)
  const clips = mainMediaClips(p).filter(isVideo)
  if (!clips.length) throw new OpError('no_video', 'Add a video to the main track first')
  const { results } = await analyze(
    ctx,
    distinct(clips),
    (assetId) => ({ kind: 'scenes', assetId, projectId: p.id, payload: { assetId } }),
    readScenes,
    (a) => a?.scenes,
    'Detecting scene changes',
    [0, 0.95],
  )
  return ensureSameProject(ctx, p.id, () =>
    ctx.store.getState().dispatch('Split at scenes', (d) => {
      let splits = 0
      for (const original of mainMediaClips(d).filter(isVideo)) {
        const cuts = results[original.assetId] ?? []
        const times = cuts
          .map((s) => sourceToTimeline(original, s))
          .filter((t): t is Us => t !== undefined)
          .sort((a, b) => a - b)
        let current = original.id
        for (const t of times) {
          try {
            current = splitClip(d, current, Math.round(t))[1].id
            splits++
          } catch (err) {
            // Cuts within a frame of a clip edge are not worth a split.
            if (!(err instanceof OpError)) throw err
          }
        }
      }
      return splits
    }),
  )
}

/* ------------------------------------------------------------------ reframe */

/** True for media wider than tall (after rotation metadata). */
export const isLandscape = (a: Asset | undefined): boolean => {
  if (!a?.width || !a.height) return false
  const quarter = Math.abs(Math.round((a.rotation ?? 0) / 90)) % 2 === 1
  return quarter ? a.height > a.width : a.width > a.height
}

/** Video clips (main or overlay) showing landscape media. */
export const landscapeClips = (p: Project, assets: Readonly<Record<string, Asset>>): MediaClip[] =>
  allClips(p, isVideo)
    .filter(({ track, clip }) => track.kind !== 'audio' && isLandscape(assets[clip.assetId]))
    .map((x) => x.clip)

/** Follows the subject of landscape clips so they fill the 9:16 frame. Returns clips reframed. */
export const autoReframe = async (
  ctx: FlowContext,
  clipIds?: readonly string[],
): Promise<number> => {
  const p = projectOf(ctx.store)
  const clips = landscapeClips(p, ctx.store.getState().assets).filter(
    (c) => !clipIds || clipIds.includes(c.id),
  )
  if (!clips.length) throw new OpError('no_landscape', 'There are no landscape clips to reframe')
  const { results } = await analyze(
    ctx,
    distinct(clips),
    (assetId) => ({ kind: 'reframe', assetId, projectId: p.id, payload: { assetId } }),
    readReframe,
    () => undefined,
    'Tracking the subject',
    [0, 0.95],
  )
  return ensureSameProject(ctx, p.id, () =>
    ctx.store.getState().dispatch('Auto reframe', (d) => {
      let n = 0
      for (const c of clips) {
        const path = results[c.assetId]
        const live = locate(d, c.id)?.clip
        if (!path?.length || !isVideo(live)) continue
        applyReframe(d, c.id, path)
        n++
      }
      return n
    }),
  )
}

/* ------------------------------------------------------------------ magic edit */

export interface MagicOptions extends CaptionOptions {
  /** Beat-sync density used when a music clip is present. */
  every?: 1 | 2 | 4
}

export interface MagicSummary {
  silences: number
  fillers: number
  removed: Us
  captionWords: number
  beatSynced: boolean
}

/**
 * One tap: cut silences and filler words, cut on the beat when there is music, then caption
 * the result. All analysis runs in parallel on the host; the edit is ONE undo step, applied
 * in the order that keeps everything consistent: cuts → beat sync → captions (captions are
 * mapped through the final cuts).
 */
export const magicEdit = async (ctx: FlowContext, o: MagicOptions): Promise<MagicSummary> => {
  const p = projectOf(ctx.store)
  const silenceAssets = distinct(mainSpeechClips(p, ctx.store))
  const speechAssets = distinct(speechClips(p, ctx.store))
  const music = musicClips(p)[0]
  if (!silenceAssets.length && !speechAssets.length && !music)
    throw new OpError('empty', 'Add some clips first')
  const label = music ? 'Analysing speech and music' : 'Analysing speech'
  // Three analyses in parallel; each owns a third of the progress bar.
  const parts = [0, 0, 0]
  const sub = (i: number): FlowContext => ({
    ...ctx,
    report: (v) => {
      parts[i] = v
      ctx.report(((parts[0]! + parts[1]! + parts[2]!) * 0.95) / 3, label)
    },
  })
  const [silence, speech, beats] = await Promise.all([
    analyze(sub(0), silenceAssets, silenceJob(p.id, {}), readSilence, () => undefined, label),
    transcribe(sub(1), speechAssets, o.language),
    music
      ? analyze(
          sub(2),
          [music.assetId],
          beatsJob(p.id),
          (r) => readBeats(r).beats,
          cachedBeats,
          label,
        )
      : Promise.resolve(undefined),
  ])
  ctx.report(0.97, 'Editing')
  const silenceRanges: CutRanges = {}
  for (const [id, r] of Object.entries(silence.results)) silenceRanges[id] = mergeRanges(r)
  const fillerPlan: CutPlan = { ranges: {}, scope: 'speech' }
  for (const [id, words] of Object.entries(speech.results))
    fillerPlan.ranges[id] = fillerRanges(words)
  const silencePlan: CutPlan = { ranges: silenceRanges, scope: 'main' }

  return ensureSameProject(ctx, p.id, () => {
    const now = projectOf(ctx.store)
    const s1 = cutStats(now, ctx.store, silencePlan)
    // Fillers inside an already-cut silence would be double counted: count on the union.
    const union: CutPlan = { ranges: {}, scope: 'speech' }
    for (const id of new Set([...Object.keys(silenceRanges), ...Object.keys(fillerPlan.ranges)]))
      union.ranges[id] = mergeRanges([
        ...(silenceRanges[id] ?? []),
        ...(fillerPlan.ranges[id] ?? []),
      ])
    const sAll = cutStats(now, ctx.store, union)
    let beatSynced = false
    const captionWords = ctx.store.getState().dispatch('Magic edit', (d) => {
      applyCuts(d, ctx.store, silencePlan)
      applyCuts(d, ctx.store, fillerPlan)
      if (music && beats) {
        const b = beats.results[music.assetId] ?? []
        if (b.length && isAudioClip(locate(d, music.id)?.clip)) {
          applyBeats(d, music.id, b, o.every ?? 2)
          beatSynced = true
        }
      }
      const words = Object.values(speech.results).reduce((n, w) => n + w.length, 0)
      if (words > 0) buildCaptions(d, speech.results, o.style, captionOpts(o))
      return d.captions?.words.length ?? 0
    })
    return {
      silences: s1.count,
      fillers: Math.max(0, sAll.count - s1.count),
      removed: sAll.removed,
      captionWords,
      beatSynced,
    }
  })
}
