/**
 * Store glue for panel controls. Every edit goes through `dispatch` (one undo step); slider
 * and colour drags are wrapped in a transaction so a whole gesture is one undo step and one
 * autosave. Failures never throw into React handlers — they surface as a toast.
 */
import { OpError, type Project } from '@reelforge/core'
import type { Draft } from 'immer'
import { toast } from '@/components/Toast.tsx'
import { editorStore, type DispatchOptions, type EditorStoreApi } from '@/state/editorStore.ts'

/** User-facing reason for a failed edit. */
export const describeError = (err: unknown): string => {
  if (err instanceof OpError)
    return err.code === 'not_implemented' ? 'This edit is not available yet' : err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export type Recipe<R = unknown> = (draft: Draft<Project>) => R

/**
 * Runs `recipe` as one undoable edit. Returns the recipe result, or `undefined` (after a
 * toast) when there is no project or the op rejected the edit.
 */
export const edit = <R>(
  label: string,
  recipe: Recipe<R>,
  opts?: DispatchOptions & { store?: EditorStoreApi; quiet?: boolean },
): R | undefined => {
  const store = opts?.store ?? editorStore
  if (!store.getState().project) return undefined
  try {
    return store.getState().dispatch(label, recipe, opts)
  } catch (err) {
    if (!opts?.quiet) toast.error(`${label} failed`, describeError(err))
    return undefined
  }
}

/** Props for `<Slider>` / `<ColorPicker>` that turn a drag into one transaction. */
export interface GestureHandlers<V> {
  onChangeStart: () => void
  onChange: (v: V) => void
  onChangeEnd: () => void
}

/**
 * Binds a continuous control to the store. Each change mutates the current draft, so the
 * recipe must be absolute ("set volume to v"), never relative.
 */
export const gesture = <V>(
  label: string,
  apply: (draft: Draft<Project>, v: V) => void,
  store: EditorStoreApi = editorStore,
): GestureHandlers<V> => ({
  onChangeStart: () => store.getState().beginTransaction(label),
  onChange: (v) => {
    edit(label, (d) => apply(d, v), { store })
  },
  onChangeEnd: () => store.getState().commitTransaction(),
})

/**
 * Like `gesture`, for ops that are not idempotent when re-applied on their own output (e.g.
 * `setClipSpeed`, which rounds the duration every call): every change restarts the
 * transaction from the gesture's base state so rounding never accumulates over a drag.
 */
export const baseGesture = <V>(
  label: string,
  apply: (draft: Draft<Project>, v: V) => void,
  store: EditorStoreApi = editorStore,
): GestureHandlers<V> => ({
  onChangeStart: () => store.getState().beginTransaction(label),
  onChange: (v) => {
    const s = store.getState()
    if (s.transaction !== null) {
      s.cancelTransaction()
      s.beginTransaction(label)
    }
    edit(label, (d) => apply(d, v), { store })
  },
  onChangeEnd: () => store.getState().commitTransaction(),
})
