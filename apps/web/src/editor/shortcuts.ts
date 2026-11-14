/**
 * Editor keyboard shortcuts. One window-level `keydown` listener dispatches through a
 * declarative table to store actions / editor commands, so the timeline and panels can
 * add bindings without fighting over listeners (see `registerShortcut`).
 *
 * Scoping: nothing fires while typing in an input, textarea, select or contenteditable, or
 * while a modal dialog is open; Escape inside fields is left to the field.
 */
import { US_PER_SECOND } from '@reelforge/core'
import { useEffect } from 'react'
import { toast } from '@/components/Toast.tsx'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { timelineEnd } from '@/state/selectors.ts'
import {
  deleteSelection,
  duplicateSelection,
  seekBy,
  splitAtPlayhead,
  stepFrames,
  type CommandResult,
} from './actions.ts'

export const ZOOM_STEP = 1.25

export interface Shortcut {
  /** `KeyboardEvent.key` values (case-insensitive for letters). */
  keys: readonly string[]
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  mod?: boolean
  /** Required Shift state; undefined = either. */
  shift?: boolean
  /** Human description (help sheet / tooltips). */
  label: string
  run: (store: EditorStoreApi, e: KeyboardEvent) => CommandResult | void
}

const report = (r: CommandResult | void) => {
  if (r && !r.ok) toast(r.reason)
}

/** Built-in bindings. Order matters: the first match wins. */
export const DEFAULT_SHORTCUTS: readonly Shortcut[] = [
  { keys: [' '], label: 'Play / pause', run: (s) => s.getState().togglePlaying() },
  // J/K/L transport: the preview engine has no reverse/shuttle rate, so J rewinds in 1 s
  // steps (hold to scrub back), K stops and L plays.
  {
    keys: ['j'],
    label: 'Rewind 1 s',
    run: (s) => {
      s.getState().setPlaying(false)
      seekBy(s, -US_PER_SECOND)
    },
  },
  { keys: ['k'], label: 'Pause', run: (s) => s.getState().setPlaying(false) },
  { keys: ['l'], label: 'Play', run: (s) => s.getState().setPlaying(true) },
  { keys: ['ArrowLeft'], shift: false, label: 'Previous frame', run: (s) => stepFrames(s, -1) },
  { keys: ['ArrowRight'], shift: false, label: 'Next frame', run: (s) => stepFrames(s, 1) },
  {
    keys: ['ArrowLeft'],
    shift: true,
    label: 'Back 1 s',
    run: (s) => {
      s.getState().setPlaying(false)
      seekBy(s, -US_PER_SECOND)
    },
  },
  {
    keys: ['ArrowRight'],
    shift: true,
    label: 'Forward 1 s',
    run: (s) => {
      s.getState().setPlaying(false)
      seekBy(s, US_PER_SECOND)
    },
  },
  { keys: ['z'], mod: true, shift: false, label: 'Undo', run: (s) => s.getState().undo() },
  { keys: ['z'], mod: true, shift: true, label: 'Redo', run: (s) => s.getState().redo() },
  { keys: ['y'], mod: true, label: 'Redo', run: (s) => s.getState().redo() },
  { keys: ['d'], mod: true, label: 'Duplicate', run: (s) => duplicateSelection(s) },
  { keys: ['s'], mod: false, label: 'Split at playhead', run: (s) => splitAtPlayhead(s) },
  {
    keys: ['Delete', 'Backspace'],
    shift: false,
    label: 'Delete',
    run: (s) => deleteSelection(s),
  },
  {
    keys: ['Delete', 'Backspace'],
    shift: true,
    label: 'Ripple delete',
    run: (s) => deleteSelection(s, true),
  },
  { keys: ['+', '='], mod: false, label: 'Zoom in', run: (s) => s.getState().zoomBy(ZOOM_STEP) },
  {
    keys: ['-', '_'],
    mod: false,
    label: 'Zoom out',
    run: (s) => s.getState().zoomBy(1 / ZOOM_STEP),
  },
  { keys: ['Home'], label: 'Go to start', run: (s) => s.getState().setPlayhead(0) },
  {
    keys: ['End'],
    label: 'Go to end',
    run: (s) => s.getState().setPlayhead(timelineEnd(s.getState().project)),
  },
  { keys: ['Escape'], label: 'Clear selection', run: (s) => s.getState().clearSelection() },
]

const extra: Shortcut[] = []

/** Adds bindings (timeline/panel features). They take precedence over the defaults. */
export const registerShortcut = (...shortcuts: Shortcut[]): (() => void) => {
  extra.unshift(...shortcuts)
  return () => {
    for (const s of shortcuts) {
      const i = extra.indexOf(s)
      if (i !== -1) extra.splice(i, 1)
    }
  }
}

/** True when keystrokes belong to a text field or a modal, not the editor. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
    return true
  return target.closest('dialog[open], [role="dialog"][aria-modal="true"]') !== null
}

const isMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Finds the binding for an event, or undefined. Exported for tests. */
export const matchShortcut = (
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  table: readonly Shortcut[] = [...extra, ...DEFAULT_SHORTCUTS],
  mac = isMac(),
): Shortcut | undefined => {
  if (e.altKey) return undefined
  const mod = mac ? e.metaKey : e.ctrlKey
  // The "other" modifier (Ctrl on mac, Win/Meta elsewhere) never maps to editor commands.
  if (mac ? e.ctrlKey : e.metaKey) return undefined
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return table.find(
    (s) =>
      s.keys.some((k) => (k.length === 1 ? k.toLowerCase() : k) === key) &&
      (s.mod ?? false) === mod &&
      (s.shift === undefined || s.shift === e.shiftKey),
  )
}

/** Creates the `keydown` handler for a store (exported for tests). */
export const createShortcutHandler =
  (store: EditorStoreApi) =>
  (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing || isTypingTarget(e.target)) return
    if (!store.getState().project) return
    const shortcut = matchShortcut(e)
    if (!shortcut) return
    // Let buttons keep their native Space/Enter activation when focused.
    if (e.key === ' ' && e.target instanceof HTMLButtonElement) return
    e.preventDefault()
    report(shortcut.run(store, e))
  }

/** Installs the editor shortcuts while the calling component is mounted. */
export const useEditorShortcuts = (store: EditorStoreApi = editorStore): void => {
  useEffect(() => {
    const handler = createShortcutHandler(store)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [store])
}
