/** Clip clipboard commands and their Ctrl/⌘+C/X/V shortcuts, on the real core ops. */
import { Asset, sec } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearClipboard,
  copySelection,
  cutSelection,
  pasteAtPlayhead,
  readClipboard,
} from '@/editor/clipboard.ts'
import { matchShortcut } from '@/editor/shortcuts.ts'
import { createEditorStore, type EditorStoreApi } from '@/state/index.ts'
import { clip, mainClips, project, track } from './timeline/helpers.ts'

const vid = Asset.parse({
  id: 'vid',
  kind: 'video',
  name: 'vid',
  size: 1,
  mime: 'video/mp4',
  createdAt: '2026-01-01T00:00:00.000Z',
  duration: sec(20),
})

let store: EditorStoreApi
const all = () => store.getState().project!.tracks.flatMap((t) => t.clips)

beforeEach(() => {
  clearClipboard()
  store = createEditorStore()
  store
    .getState()
    .load(
      project([
        track('main', mainClips(2, 2), 'main'),
        track('text', [clip('text', sec(1), sec(1), { id: 'tx' })], 'tt'),
      ]),
      [vid],
    )
})

afterEach(() => clearClipboard())

describe('clipboard', () => {
  it('copies across tracks and pastes at the playhead as ONE undo step', () => {
    store.getState().select(['m0', 'tx'])
    expect(copySelection(store)).toEqual({ ok: true })
    expect(readClipboard()?.entries).toHaveLength(2)
    store.getState().setPlayhead(sec(4))
    expect(pasteAtPlayhead(store)).toEqual({ ok: true })
    expect(all()).toHaveLength(5)
    const sel = store.getState().selection.clipIds
    expect(sel).toHaveLength(2)
    expect(sel).not.toContain('m0')
    expect(store.getState().history.undoLabel).toBe('Paste 2 clips')
    store.getState().undo()
    expect(all()).toHaveLength(3)
  })

  it('cut removes the clips and keeps them pasteable', () => {
    store.getState().select(['tx'])
    expect(cutSelection(store)).toEqual({ ok: true })
    expect(all().some((c) => c.id === 'tx')).toBe(false)
    expect(pasteAtPlayhead(store)).toEqual({ ok: true })
    expect(all().filter((c) => c.type === 'text')).toHaveLength(1)
  })

  it('survives a reload (persisted) and reports empty / missing media', () => {
    expect(pasteAtPlayhead(store)).toEqual({ ok: false, reason: 'Clipboard is empty' })
    expect(copySelection(store)).toEqual({ ok: false, reason: 'Nothing selected' })
    store.getState().select(['m1'])
    copySelection(store)
    expect(JSON.parse(localStorage.getItem('rf.clipboard')!).entries).toHaveLength(1)
    store.getState().setAssets([])
    expect(pasteAtPlayhead(store).ok).toBe(false)
  })

  it('binds Ctrl+C / X / V', () => {
    const k = (key: string) =>
      matchShortcut(
        { key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
        undefined,
        false,
      )
    expect(k('c')?.label).toBe('Copy')
    expect(k('x')?.label).toBe('Cut')
    expect(k('v')?.label).toBe('Paste')
  })
})
