/**
 * Auto Edit as an AI task, the variant switcher, and the hand-off from Home ("Auto edit"
 * with fresh uploads) to the editor, which starts the edit once every clip has landed.
 */
import type { Asset, Project } from '@reelforge/core'
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { api } from '@/api/index.ts'
import { usePacks, useSystem } from '@/api/queries.ts'
import { toast } from '@/components/Toast.tsx'
import { sleep } from '@/lib/backoff.ts'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { uploadsStore } from '@/state/uploads.ts'
import { mainMediaClips } from '../../model/draft.ts'
import { aiTasks, type AiTasks } from '../tasks.ts'
import {
  applyAutoEdit,
  AUTO_EDIT_LABEL,
  autoEdit,
  type AutoEditDeps,
  type AutoEditOptions,
  type AutoEditResult,
  type TargetSeconds,
} from './flow.ts'
import { httpMusic, httpTrends } from './ports.ts'

/* ------------------------------------------------------------------ variants */

export interface AutoEditSession {
  projectId: string
  result: AutoEditResult
  active: number
}

export const autoEditSessions = createStore<{ session: AutoEditSession | null }>()(() => ({
  session: null,
}))

export const useAutoEditSession = (projectId: string | undefined): AutoEditSession | null =>
  useStore(autoEditSessions, (s) => (s.session?.projectId === projectId ? s.session : null))

/**
 * Swaps in another variant: undoes the Auto edit step and applies the other one, so the
 * history still holds a single "Auto edit". Refused once the user has edited on top.
 */
export const switchVariant = (index: number, store: EditorStoreApi = editorStore): boolean => {
  const s = autoEditSessions.getState().session
  const { project, history } = store.getState()
  const variant = s?.result.variants[index]
  if (!s || !variant || !project || s.projectId !== project.id || index === s.active) return false
  // The step on top of the undo stack must still be our Auto edit (nothing edited since).
  if (history.undoLabel !== AUTO_EDIT_LABEL) {
    toast.error('You edited after Auto edit', 'Undo your changes first, or run Auto edit again.')
    return false
  }
  store.getState().undo()
  applyAutoEdit(store, s.result, variant)
  autoEditSessions.setState({ session: { ...s, active: index } })
  return true
}

/* ------------------------------------------------------------------ task */

/** Polls the host until an imported asset is probed. */
export const waitForProbe = async (asset: Asset, signal: AbortSignal): Promise<Asset> => {
  for (let i = 0; i < 240; i++) {
    const a = await api.asset(asset.id, signal)
    if (a.duration) return a
    await sleep(500, signal)
  }
  throw new Error('The music took too long to process')
}

const defaultDeps: AutoEditDeps = {
  music: httpMusic,
  trends: httpTrends,
  waitForAsset: waitForProbe,
}

const seconds = (us: number): string => `${Math.round(us / 1_000_000)} s`

export const startAutoEdit = (
  o: AutoEditOptions,
  deps: AutoEditDeps = defaultDeps,
  tasks: AiTasks = aiTasks,
): void =>
  tasks.start('autoedit', 'Auto edit', async (ctx) => {
    const { result, stats } = await autoEdit(ctx, o, deps)
    const projectId = ctx.store.getState().project?.id ?? ''
    autoEditSessions.setState({
      session: { projectId, result, active: 0 },
    })
    const bits = [
      `${stats.clips} moments`,
      seconds(stats.duration),
      stats.beatSynced && 'on the beat',
      stats.captionWords > 0 && 'captioned',
    ].filter(Boolean)
    return { kind: 'done', message: `Auto edit: ${bits.join(' · ')}` }
  })

/* ------------------------------------------------------------------ Home → editor hand-off */

export interface PendingAutoEdit {
  target: TargetSeconds
  vibe: string
  topic?: string
}

const pending = new Map<string, PendingAutoEdit>()

/** Remembers an Auto edit to run when the new project's uploads have landed. */
export const queueAutoEdit = (projectId: string, o: PendingAutoEdit): void => {
  pending.set(projectId, o)
}

export const pendingAutoEdit = (projectId: string): PendingAutoEdit | undefined =>
  pending.get(projectId)

/** True once every timeline upload of the project is placed (or failed) and clips exist. */
export const uploadsLanded = (projectId: string, project: Project | null): boolean => {
  if (!project || project.id !== projectId) return false
  const tasks = uploadsStore
    .getState()
    .tasks.filter((t) => t.projectId === projectId && t.addToTimeline)
  const open = tasks.some((t) => !t.inserted && t.status !== 'error' && t.status !== 'cancelled')
  return !open && mainMediaClips(project).length > 0
}

/** Editor hook: starts a queued Auto edit as soon as the project's clips are in place. */
export const useAutoEditLauncher = (projectId: string): void => {
  const packs = usePacks().data
  const system = useSystem()
  const llm = system.data?.llm?.installed ?? false
  const ready = !system.isPending
  useEffect(() => {
    if (!ready || !pending.has(projectId)) return
    const check = (): void => {
      const o = pending.get(projectId)
      if (!o || !uploadsLanded(projectId, editorStore.getState().project)) return
      pending.delete(projectId)
      startAutoEdit({
        ...o,
        language: editorStore.getState().project?.captions?.language ?? 'auto',
        llm,
        ...(packs ? { packs } : {}),
      })
    }
    check()
    const a = uploadsStore.subscribe(check)
    const b = editorStore.subscribe(check)
    return () => {
      a()
      b()
    }
  }, [projectId, packs, llm, ready])
}
