/**
 * Running AI tasks, outside React: a task keeps going (and applies its edit) when its sheet
 * is closed, the tool bar shows its progress, and a failed task can be retried with the
 * same inputs. One task per id at a time.
 */
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { api, events } from '@/api/index.ts'
import { toast } from '@/components/Toast.tsx'
import { isAbortError } from '@/lib/backoff.ts'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { describeError } from '../model/commands.ts'
import type { FlowContext } from './flows.ts'
import type { JobDeps } from './jobs.ts'

export type AiTaskId =
  | 'silence'
  | 'fillers'
  | 'captions'
  | 'beats'
  | 'scenes'
  | 'reframe'
  | 'magic'
  | 'autoedit'
  | 'highlights'
  | 'copy'
  | 'emphasis'

/** What a finished flow hands back: a message, or a preview the user confirms. */
export type TaskOutcome =
  | { kind: 'done'; message: string; undoable?: boolean }
  | { kind: 'review'; summary: string; detail?: string; apply: () => string }

export type TaskStatus = 'running' | 'review' | 'error'

export interface TaskState {
  id: AiTaskId
  label: string
  status: TaskStatus
  /** 0..1 */
  progress: number
  message: string
  error?: string
  review?: { summary: string; detail?: string }
  projectId: string
}

interface Internal {
  run: (ctx: FlowContext) => Promise<TaskOutcome>
  controller: AbortController
  apply?: () => string
}

export interface AiTasks {
  store: StoreApi<{ tasks: Partial<Record<AiTaskId, TaskState>> }>
  start(id: AiTaskId, label: string, run: (ctx: FlowContext) => Promise<TaskOutcome>): void
  retry(id: AiTaskId): void
  cancel(id: AiTaskId): void
  /** Confirms a task waiting for review (applies its edit). */
  apply(id: AiTaskId): void
  dismiss(id: AiTaskId): void
}

/** Creates an isolated task registry (the app uses the `aiTasks` singleton). */
export const createAiTasks = (deps: { store: EditorStoreApi; jobs: JobDeps }): AiTasks => {
  const store = createStore<{ tasks: Partial<Record<AiTaskId, TaskState>> }>()(() => ({
    tasks: {},
  }))
  const internals = new Map<AiTaskId, Internal>()

  const patch = (id: AiTaskId, p: Partial<TaskState> | null) =>
    store.setState((s) => {
      const tasks = { ...s.tasks }
      const cur = tasks[id]
      if (p === null) delete tasks[id]
      else if (cur) tasks[id] = { ...cur, ...p }
      return { tasks }
    })

  const undoAction = () => ({
    label: 'Undo',
    onClick: () => deps.store.getState().undo(),
  })

  const execute = (id: AiTaskId, label: string, internal: Internal) => {
    const projectId = deps.store.getState().project?.id
    if (!projectId) return
    internals.set(id, internal)
    store.setState((s) => ({
      tasks: {
        ...s.tasks,
        [id]: { id, label, status: 'running', progress: 0, message: 'Starting…', projectId },
      },
    }))
    let lastPct = -1
    const ctx: FlowContext = {
      store: deps.store,
      jobs: deps.jobs,
      signal: internal.controller.signal,
      report: (progress, message) => {
        // Whole-percent steps: progress events can arrive far faster than anyone can see.
        const pct = Math.floor(progress * 100)
        if (pct === lastPct && store.getState().tasks[id]?.message === message) return
        lastPct = pct
        patch(id, { progress, message })
      },
    }
    internal.run(ctx).then(
      (outcome) => {
        if (internals.get(id) !== internal) return
        if (deps.store.getState().project?.id !== projectId) {
          internals.delete(id)
          patch(id, null)
          return
        }
        if (outcome.kind === 'review') {
          internal.apply = outcome.apply
          patch(id, {
            status: 'review',
            progress: 1,
            review: {
              summary: outcome.summary,
              ...(outcome.detail ? { detail: outcome.detail } : {}),
            },
          })
          return
        }
        internals.delete(id)
        patch(id, null)
        toast(outcome.message, {
          tone: 'success',
          ...(outcome.undoable === false ? {} : { action: undoAction() }),
        })
      },
      (err: unknown) => {
        if (internals.get(id) !== internal) return
        // A failure after the user switched projects (often caused by the switch) is moot.
        const moved = deps.store.getState().project?.id !== projectId
        if (moved || isAbortError(err) || internal.controller.signal.aborted) {
          internals.delete(id)
          patch(id, null)
          return
        }
        patch(id, { status: 'error', error: describeError(err) })
      },
    )
  }

  return {
    store,
    start(id, label, run) {
      internals.get(id)?.controller.abort()
      execute(id, label, { run, controller: new AbortController() })
    },
    retry(id) {
      const prev = internals.get(id)
      const state = store.getState().tasks[id]
      if (!prev || !state) return
      execute(id, state.label, { run: prev.run, controller: new AbortController() })
    },
    cancel(id) {
      const internal = internals.get(id)
      internals.delete(id)
      internal?.controller.abort(new DOMException('Cancelled', 'AbortError'))
      patch(id, null)
    },
    apply(id) {
      const internal = internals.get(id)
      const state = store.getState().tasks[id]
      if (!internal?.apply || state?.status !== 'review') return
      if (deps.store.getState().project?.id !== state.projectId) {
        this.dismiss(id)
        return
      }
      try {
        const message = internal.apply()
        internals.delete(id)
        patch(id, null)
        toast(message, { tone: 'success', action: undoAction() })
      } catch (err) {
        patch(id, { status: 'error', error: describeError(err) })
      }
    },
    dismiss(id) {
      internals.get(id)?.controller.abort()
      internals.delete(id)
      patch(id, null)
    },
  }
}

/** App-wide AI task registry bound to the editor store and the host API. */
export const aiTasks: AiTasks = createAiTasks({ store: editorStore, jobs: { api, events } })

/** Subscribe to one task's state (undefined when idle). */
export const useAiTask = (id: AiTaskId, tasks: AiTasks = aiTasks): TaskState | undefined =>
  useStore(tasks.store, (s) => s.tasks[id])

/** True while any AI task is running (tool bar indicator). */
export const useAnyAiRunning = (tasks: AiTasks = aiTasks): boolean =>
  useStore(tasks.store, (s) => Object.values(s.tasks).some((t) => t?.status === 'running'))
