/**
 * One function per AI tool: starts the flow as a task and turns its result into the
 * message (or the review step) the user sees. Shared by the AI panel, the captions panel
 * and the inspector.
 */
import type { CaptionStyle, Us } from '@reelforge/core'
import type { Packs } from '@/api/schemas.ts'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { catalog } from '../model/catalog.ts'
import {
  applyCutPlan,
  autoCaptions,
  autoReframe,
  beatSync,
  cutStats,
  magicEdit,
  planFillers,
  planSilence,
  splitScenes,
  type CutPlan,
  type SilenceOptions,
} from './flows.ts'
import { aiTasks, type AiTasks } from './tasks.ts'

const seconds = (us: Us): string => `${(us / 1_000_000).toFixed(1)} s`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Schema-default caption look (used when no pack style is available). */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  base: {
    fontFamily: 'Montserrat',
    fontWeight: 800,
    italic: false,
    fontSize: 72,
    color: '#FFFFFF',
    strokeColor: '#000000',
    strokeWidth: 6,
    shadowColor: '#00000099',
    shadowBlur: 0,
    shadowX: 0,
    shadowY: 4,
    backgroundPadding: 16,
    backgroundRadius: 12,
    align: 'center',
    letterSpacing: 0,
    lineHeight: 1.1,
    uppercase: false,
    maxWidth: 900,
  },
  activeColor: '#FFE400',
  activeScale: 1.15,
  mode: 'karaoke',
  maxWordsPerLine: 3,
  maxLines: 1,
  y: 1300,
  emphasizeKeywords: true,
  keywordColor: '#00E5FF',
}

/** Style for new captions: the project's current one, else the most trending pack style. */
export const captionStyleFor = (
  packs: Packs | undefined,
  store: EditorStoreApi = editorStore,
): { style: CaptionStyle; ref?: string } => {
  const current = store.getState().project?.captions
  if (current)
    return { style: current.style, ...(current.styleRef ? { ref: current.styleRef } : {}) }
  const top = catalog(packs, 'captionStyles')[0]
  return top ? { style: top.item.style, ref: top.ref } : { style: DEFAULT_CAPTION_STYLE }
}

const reviewCut = (store: EditorStoreApi, plan: CutPlan, what: string, label: string) => {
  const p = store.getState().project
  const stats = p ? cutStats(p, store, plan) : { count: 0, removed: 0 }
  if (stats.count === 0)
    return { kind: 'done' as const, message: `No ${what} found`, undoable: false }
  return {
    kind: 'review' as const,
    summary: `${plural(stats.count, what.replace(/s$/, ''), what)} · saves ${seconds(stats.removed)}`,
    apply: () => {
      const done = applyCutPlan(store, plan, label)
      return done.count
        ? `Removed ${plural(done.count, what.replace(/s$/, ''), what)}`
        : `No ${what} left to remove`
    },
  }
}

export const startSilence = (o: SilenceOptions = {}, tasks: AiTasks = aiTasks): void =>
  tasks.start('silence', 'Remove silences', async (ctx) =>
    reviewCut(ctx.store, await planSilence(ctx, o), 'silences', 'Remove silences'),
  )

export const startFillers = (language = 'auto', tasks: AiTasks = aiTasks): void =>
  tasks.start('fillers', 'Remove filler words', async (ctx) =>
    reviewCut(ctx.store, await planFillers(ctx, language), 'filler words', 'Remove filler words'),
  )

export const startCaptions = (
  o: { style: CaptionStyle; styleRef?: string; language: string },
  tasks: AiTasks = aiTasks,
): void =>
  tasks.start('captions', 'Auto captions', async (ctx) => {
    const words = await autoCaptions(ctx, o)
    return { kind: 'done', message: `Captioned ${plural(words, 'word')}` }
  })

export const startBeatSync = (
  o: { musicClipId: string; every: 1 | 2 | 4 },
  tasks: AiTasks = aiTasks,
): void =>
  tasks.start('beats', 'Beat sync', async (ctx) => {
    const n = await beatSync(ctx, o)
    return { kind: 'done', message: `Synced cuts to ${plural(n, 'beat')}` }
  })

export const startScenes = (tasks: AiTasks = aiTasks): void =>
  tasks.start('scenes', 'Split at scenes', async (ctx) => {
    const n = await splitScenes(ctx)
    return n
      ? { kind: 'done', message: `Split at ${plural(n, 'scene change')}` }
      : { kind: 'done', message: 'No scene changes found', undoable: false }
  })

export const startReframe = (clipIds?: readonly string[], tasks: AiTasks = aiTasks): void =>
  tasks.start('reframe', 'Auto reframe', async (ctx) => {
    const n = await autoReframe(ctx, clipIds)
    return { kind: 'done', message: `Reframed ${plural(n, 'clip')} to follow the subject` }
  })

export const startMagic = (
  o: { style: CaptionStyle; styleRef?: string; language: string },
  tasks: AiTasks = aiTasks,
): void =>
  tasks.start('magic', 'Magic edit', async (ctx) => {
    const s = await magicEdit(ctx, o)
    const parts = [
      s.silences && plural(s.silences, 'silence'),
      s.fillers && plural(s.fillers, 'filler word'),
    ].filter(Boolean)
    const cut = parts.length
      ? `Cut ${parts.join(' & ')} (${seconds(s.removed)})`
      : 'No pauses to cut'
    const extra = [s.beatSynced && 'synced to the beat', s.captionWords > 0 && 'captioned'].filter(
      Boolean,
    )
    return { kind: 'done', message: extra.length ? `${cut}, ${extra.join(' and ')}` : cut }
  })
