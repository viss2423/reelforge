/**
 * Transient preview override: a gesture (on-canvas transform, inline text edit) shows its
 * in-progress result by handing the preview engine a patched project directly, without
 * touching the editor store — so nothing in React re-renders per pointer move and the
 * gesture still commits as ONE undoable dispatch at the end.
 */
import type { Project } from '@reelforge/core'

type Listener = (p: Project | null) => void

let current: Project | null = null
const listeners = new Set<Listener>()

/** Shows `p` in the preview instead of the store's project; `null` returns to the store. */
export const setPreviewOverride = (p: Project | null): void => {
  if (p === current) return
  current = p
  for (const l of listeners) l(p)
}

export const previewOverride = (): Project | null => current

export const subscribePreviewOverride = (l: Listener): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
