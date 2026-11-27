/**
 * Auto Edit: raw clips → finished reel in one tap.
 *
 *   1. analyse on the host, reusing cached results: speech (transcribe), shots (scenes),
 *      music beats; add music from the library when the project has none;
 *   2. `highlights` (LLM, or the heuristic ranker) picks the hook and the best moments in
 *      story order, as 2–3 variants; `copywriter` writes the hook text (LLM only);
 *   3. each variant becomes an AutoEditPlan (vibe → trend-pack look, beat grid, captions,
 *      hook text, ducked music) that core's `assembleAutoEdit` applies as ONE undo step.
 *
 * Everything heavy runs on the host; this module only orchestrates jobs and builds data.
 */
import {
  assembleAutoEdit,
  OpError,
  type Asset,
  type AutoEditPlan,
  type AutoEditStats,
  type MediaClip,
  type Project,
  type Us,
  type Word,
} from '@reelforge/core'
import type { Packs } from '@/api/schemas.ts'
import type { EditorStoreApi } from '@/state/editorStore.ts'
import { isVideo, mainMediaClips } from '../../model/draft.ts'
import {
  analyze,
  beatsJob,
  cachedBeats,
  distinct,
  ensureSameProject,
  musicClips,
  projectOf,
  readBeatTimes,
  transcribe,
  type FlowContext,
} from '../flows.ts'
import { runJobs } from '../jobs.ts'
import {
  readCopy,
  readHighlights,
  readScenes,
  type Copy,
  type HighlightMoment,
  type Highlights,
} from '../results.ts'
import type { MusicPort, MusicTrack, Trends, TrendingSound, TrendsPort } from './ports.ts'
import { pickStyle, vibeById, type AutoStyle } from './style.ts'

export const TARGETS = [15, 30, 60] as const
export type TargetSeconds = (typeof TARGETS)[number]

export interface AutoEditOptions {
  target: TargetSeconds
  vibe: string
  topic?: string
  language: string
  /** Whether the host has the language model (hook text needs it). */
  llm: boolean
  /** Add music from the library when the project has none. */
  autoMusic?: boolean
  packs?: Packs
}

export interface AutoEditDeps {
  music?: MusicPort
  trends?: TrendsPort
  /** Waits until an imported asset is probed (duration known). */
  waitForAsset?: (asset: Asset, signal: AbortSignal) => Promise<Asset>
}

export interface AutoEditVariant {
  id: string
  label: string
  plan: AutoEditPlan
  /** Total length of the moments (µs) before beat sync. */
  duration: Us
}

export interface AutoEditResult {
  ranker: Highlights['ranker']
  variants: AutoEditVariant[]
  /** Assets the plans reference (includes imported music). */
  assets: Record<string, Asset>
  copy?: Copy
  music?: { title: string; imported: boolean; trendMatch?: { title: string; artist?: string } }
  /** Today's trending sound to add when posting (never bundled or generated). */
  trendingSound?: TrendingSound
  /** Non-fatal problems ("no music library", "hook text unavailable"). */
  notes: string[]
}

const SEC = 1_000_000

/** Source window a main clip plays (images: whole). */
const sourceOf = (c: MediaClip): { assetId: string; start?: Us; end?: Us } =>
  c.type === 'image'
    ? { assetId: c.assetId }
    : { assetId: c.assetId, start: c.in, end: c.in + Math.round(c.duration * c.speed) }

/** First words of the hook moment as fallback hook text (no LLM). */
export const fallbackHookText = (
  hook: HighlightMoment | undefined,
  transcripts: Readonly<Record<string, readonly Word[]>>,
  topic?: string,
): string | undefined => {
  if (topic?.trim()) return topic.trim()
  if (!hook) return undefined
  const words = (transcripts[hook.assetId] ?? []).filter(
    (w) => !w.filler && w.start >= hook.start - 100_000 && w.end <= hook.end + 200_000,
  )
  if (words.length < 3) return undefined
  const text = words
    .slice(0, 7)
    .map((w) => w.text.trim())
    .join(' ')
    .replace(/[,.;:]+$/, '')
  return words.length > 7 ? `${text}…` : text
}

export interface PlanInput {
  moments: readonly HighlightMoment[]
  style: AutoStyle
  vibe: ReturnType<typeof vibeById>
  transcripts: Readonly<Record<string, readonly Word[]>>
  hasSpeech: boolean
  language: string
  hookText?: string
  music?: {
    clipId?: string
    asset?: Asset
    in?: Us
    beats: readonly Us[]
    /** Bar starts (source time): with a clear grid, bar-length cuts land on real bars. */
    downbeats?: readonly Us[]
  }
}

/** One variant's plan (pure; exported for tests). */
export const buildPlan = (i: PlanInput): AutoEditPlan => ({
  moments: i.moments.map((m) => ({ assetId: m.assetId, start: m.start, end: m.end, role: m.role })),
  ...(i.style.filter ? { filter: i.style.filter } : {}),
  // Talking footage keeps hard cuts: transitions over speech feel like mistakes.
  ...(i.style.transition && !i.hasSpeech
    ? { transition: { ...i.style.transition, every: 1 } }
    : i.style.transition
      ? { transition: { ...i.style.transition, every: 3 } }
      : {}),
  ...(i.music
    ? {
        music: {
          ...(i.music.clipId ? { clipId: i.music.clipId } : {}),
          ...(i.music.asset ? { asset: i.music.asset } : {}),
          ...(i.music.in !== undefined ? { in: i.music.in } : {}),
          beats: i.music.beats,
          ...(i.music.downbeats?.length ? { downbeats: i.music.downbeats } : {}),
          // Speech sets the pace: cut on bars so sentences are not chopped.
          every: i.hasSpeech ? 4 : i.vibe.every,
          duck: i.hasSpeech,
          ...(i.hasSpeech ? { volume: 0.6 } : {}),
        },
      }
    : {}),
  ...(i.hasSpeech
    ? {
        captions: {
          transcripts: i.transcripts,
          style: i.style.caption.style,
          ...(i.style.caption.ref ? { styleRef: i.style.caption.ref } : {}),
          language: i.language,
        },
      }
    : {}),
  ...(i.hookText
    ? {
        hookText: {
          text: i.hookText,
          ...(i.style.hookText
            ? {
                style: i.style.hookText.item.style,
                presetRef: i.style.hookText.ref,
                ...(i.style.hookText.item.animationIn
                  ? { animationIn: { ref: i.style.hookText.item.animationIn, duration: 400_000 } }
                  : {}),
                ...(i.style.hookText.item.animationOut
                  ? { animationOut: { ref: i.style.hookText.item.animationOut, duration: 300_000 } }
                  : {}),
              }
            : {}),
        },
      }
    : {}),
})

/** Analyses the project and returns the variants (does not edit the project). */
export const planAutoEdit = async (
  ctx: FlowContext,
  o: AutoEditOptions,
  deps: AutoEditDeps = {},
): Promise<AutoEditResult> => {
  const p = projectOf(ctx.store)
  const clips = mainMediaClips(p)
  if (!clips.length) throw new OpError('no_clips', 'Add some clips to the timeline first')
  const assets = { ...ctx.store.getState().assets }
  const vibe = vibeById(o.vibe)
  const notes: string[] = []
  const target = o.target * SEC
  const videoAssets = distinct(clips.filter(isVideo))
  const speechAssets = videoAssets.filter((id) => assets[id]?.hasAudio !== false)
  const existingMusic = musicClips(p)[0]

  // 1. Analysis (host jobs run in parallel; cached results are reused).
  const parts = [0, 0, 0]
  const sub = (k: number, label: string): FlowContext => ({
    ...ctx,
    report: (v) => {
      parts[k] = v
      ctx.report(((parts[0]! + parts[1]! + parts[2]!) / 3) * 0.55, label)
    },
  })
  const label = 'Analysing your clips'
  const trendsP = deps.trends?.get(ctx.signal).catch(() => undefined) ?? Promise.resolve(undefined)
  const [speech, , beats] = await Promise.all([
    speechAssets.length
      ? transcribe(sub(0, label), speechAssets, o.language)
      : Promise.resolve({ results: {} as Record<string, Word[]> }),
    videoAssets.length
      ? analyze(
          sub(1, label),
          videoAssets,
          (assetId) => ({ kind: 'scenes', assetId, projectId: p.id, payload: { assetId } }),
          readScenes,
          (a) => a?.scenes,
          label,
        )
      : Promise.resolve(undefined),
    existingMusic
      ? analyze(
          sub(2, label),
          [existingMusic.assetId],
          beatsJob(p.id),
          readBeatTimes,
          cachedBeats,
          label,
        )
      : Promise.resolve(undefined),
  ])
  const transcripts = speech.results
  const hasSpeech = Object.values(transcripts).some((w) => w.filter((x) => !x.filler).length >= 8)
  const trends: Trends | undefined = await trendsP

  // 2. Moments (+ hook copy).
  ctx.report(0.58, o.llm ? 'Choosing the best moments (AI)' : 'Choosing the best moments')
  const [hl] = await runJobs(
    ctx.jobs,
    [
      {
        kind: 'highlights',
        projectId: p.id,
        payload: {
          sources: clips.map(sourceOf),
          target,
          vibe: vibe.label.toLowerCase(),
          ...(o.topic ? { topic: o.topic } : {}),
        },
      },
    ],
    {
      signal: ctx.signal,
      onProgress: (v) => ctx.report(0.58 + 0.2 * v, 'Choosing the best moments'),
    },
  )
  const highlights = readHighlights(hl!.result)

  let copy: Copy | undefined
  if (o.llm) {
    ctx.report(0.8, 'Writing the hook')
    try {
      const [c] = await runJobs(
        ctx.jobs,
        [
          {
            kind: 'copywriter',
            projectId: p.id,
            payload: {
              assetIds: speechAssets,
              language: o.language,
              vibe: vibe.label.toLowerCase(),
              ...(o.topic ? { topic: o.topic } : {}),
            },
          },
        ],
        { signal: ctx.signal },
      )
      copy = readCopy(c!.result)
    } catch (err) {
      if (ctx.signal.aborted) throw err
      notes.push('hook text unavailable')
    }
  }

  const trendingSound = trends?.sounds[0]
  // 3. Music: the user's track, else one from the library matched to the vibe.
  let music: PlanInput['music']
  let musicInfo: AutoEditResult['music']
  if (existingMusic) {
    const times = beats?.results[existingMusic.assetId]
    music = {
      clipId: existingMusic.id,
      beats: times?.beats ?? [],
      ...(times?.downbeats.length ? { downbeats: times.downbeats } : {}),
    }
    musicInfo = { title: existingMusic.name ?? 'Your music', imported: false }
  } else if (o.autoMusic !== false && deps.music) {
    ctx.report(0.84, 'Finding music')
    try {
      // Royalty-free only, ranked by similarity to today's trending sounds (host default
      // `order: 'trend'`); the vibe's mood breaks ties. Never generated, never the chart song.
      const tracks: MusicTrack[] = await deps.music.suggest(
        { mood: vibe.mood, order: 'trend', duration: target, hasSpeech },
        ctx.signal,
      )
      const track = tracks[0]
      if (track) {
        const imported = await deps.music.import(track, ctx.signal)
        let asset = imported.asset
        if (!asset.duration && deps.waitForAsset) asset = await deps.waitForAsset(asset, ctx.signal)
        assets[asset.id] = asset
        let times = imported.beats?.length
          ? { beats: imported.beats, downbeats: imported.downbeats ?? [] }
          : undefined
        if (!times) {
          const b = await analyze(
            ctx,
            [asset.id],
            beatsJob(p.id),
            readBeatTimes,
            cachedBeats,
            'Finding the beat',
            [0.86, 0.95],
          )
          times = b.results[asset.id]
        }
        const start = imported.section?.start ?? track.startAt
        music = {
          asset,
          ...(start !== undefined ? { in: start } : {}),
          beats: times?.beats ?? [],
          ...(times?.downbeats.length ? { downbeats: times.downbeats } : {}),
        }
        musicInfo = {
          title: track.title,
          imported: true,
          ...(track.trendMatch ? { trendMatch: track.trendMatch } : {}),
        }
      } else notes.push('no matching music found')
    } catch (err) {
      if (ctx.signal.aborted) throw err
      notes.push('music library unavailable')
    }
  }

  // 4. Plans.
  const current = p.captions
    ? { style: p.captions.style, ...(p.captions.styleRef ? { ref: p.captions.styleRef } : {}) }
    : undefined
  const style = pickStyle(o.packs, vibe, trends, current)
  const hookText =
    copy?.hooks[0] ?? fallbackHookText(highlights.variants[0]?.moments[0], transcripts, o.topic)
  const variants = highlights.variants.map((v) => ({
    id: v.id,
    label: v.label,
    duration: v.duration,
    plan: buildPlan({
      moments: v.moments,
      style,
      vibe,
      transcripts,
      hasSpeech,
      language: o.language,
      ...(hookText ? { hookText } : {}),
      ...(music ? { music } : {}),
    }),
  }))
  ctx.report(0.97, 'Editing')
  return {
    ranker: highlights.ranker,
    variants,
    assets,
    ...(copy ? { copy } : {}),
    ...(musicInfo ? { music: musicInfo } : {}),
    ...(trendingSound ? { trendingSound } : {}),
    notes,
  }
}

export const AUTO_EDIT_LABEL = 'Auto edit'

/** Applies one variant as a single undo step. */
export const applyAutoEdit = (
  store: EditorStoreApi,
  result: Pick<AutoEditResult, 'assets'>,
  variant: AutoEditVariant,
): AutoEditStats =>
  store.getState().dispatch(AUTO_EDIT_LABEL, (d: Project) => {
    const assets = { ...result.assets, ...store.getState().assets }
    return assembleAutoEdit(d, variant.plan, assets)
  })

/** Plans then applies the first variant, guarding against project switches. */
export const autoEdit = async (
  ctx: FlowContext,
  o: AutoEditOptions,
  deps: AutoEditDeps = {},
): Promise<{ result: AutoEditResult; stats: AutoEditStats }> => {
  const projectId = projectOf(ctx.store).id
  const result = await planAutoEdit(ctx, o, deps)
  const first = result.variants[0]
  if (!first) throw new OpError('no_moments', 'No usable moments were found')
  const stats = ensureSameProject(ctx, projectId, () => applyAutoEdit(ctx.store, result, first))
  return { result, stats }
}
