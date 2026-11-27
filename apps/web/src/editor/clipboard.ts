/**
 * Clip clipboard: copy / cut / paste of the selected clips across tracks (Ctrl/⌘+C, X, V).
 * The data is core's plain-JSON `ClipboardData`, kept in memory and mirrored to
 * localStorage so clips can be pasted into another project opened on the same device.
 */
import { copyClips, deleteClips, pasteClips, type ClipboardData } from '@reelforge/core'
import type { EditorStoreApi } from '@/state/editorStore.ts'
import type { CommandResult } from './actions.ts'

const KEY = 'rf.clipboard'
let memory: ClipboardData | null = null

const fail = (reason: string): CommandResult => ({ ok: false, reason })

/** Current clipboard (memory first, then the persisted copy). */
export const readClipboard = (): ClipboardData | null => {
  if (memory) return memory
  try {
    const raw = localStorage.getItem(KEY)
    const data = raw ? (JSON.parse(raw) as ClipboardData) : null
    memory = data?.version === 1 && Array.isArray(data.entries) ? data : null
  } catch {
    memory = null
  }
  return memory
}

const write = (data: ClipboardData): void => {
  memory = data
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    // Too big or storage blocked: the in-memory copy still works in this tab.
  }
}

/** Clears the clipboard (tests). */
export const clearClipboard = (): void => {
  memory = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

export const copySelection = (store: EditorStoreApi): CommandResult => {
  const { project, selection } = store.getState()
  if (!project) return fail('No project open')
  if (!selection.clipIds.length) return fail('Nothing selected')
  write(copyClips(project, selection.clipIds))
  return { ok: true }
}

export const cutSelection = (store: EditorStoreApi): CommandResult => {
  const r = copySelection(store)
  if (!r.ok) return r
  const ids = store.getState().selection.clipIds
  try {
    store
      .getState()
      .dispatch(ids.length > 1 ? `Cut ${ids.length} clips` : 'Cut clip', (d) => deleteClips(d, ids))
    store.getState().clearSelection()
    return { ok: true }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

/** Pastes at the playhead; the pasted clips become the selection. */
export const pasteAtPlayhead = (store: EditorStoreApi): CommandResult => {
  const data = readClipboard()
  if (!data || data.entries.length === 0) return fail('Clipboard is empty')
  const { project, playhead, assets } = store.getState()
  if (!project) return fail('No project open')
  const missing = data.entries.some(
    (e) => 'assetId' in e.clip && e.clip.assetId !== undefined && !assets[e.clip.assetId],
  )
  if (missing) return fail('Some copied media is no longer in the library')
  try {
    const ids = store
      .getState()
      .dispatch(
        data.entries.length > 1 ? `Paste ${data.entries.length} clips` : 'Paste clip',
        (d) => pasteClips(d, data, { at: playhead }).map((c) => c.id),
      )
    store.getState().select(ids)
    return { ok: true }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
