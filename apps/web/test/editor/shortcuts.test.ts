import { sec } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import {
  DEFAULT_SHORTCUTS,
  ZOOM_STEP,
  createShortcutHandler,
  isTypingTarget,
  matchShortcut,
  registerShortcut,
  type Shortcut,
} from '@/editor/shortcuts.ts'
import { makeProject } from '../fixtures.ts'

const key = (
  k: string,
  mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

const label = (k: ReturnType<typeof key>, mac = false) =>
  matchShortcut(k, DEFAULT_SHORTCUTS, mac)?.label

describe('matchShortcut', () => {
  it('maps the documented keys', () => {
    expect(label(key(' '))).toBe('Play / pause')
    expect(label(key('j'))).toBe('Rewind 1 s')
    expect(label(key('K'))).toBe('Pause')
    expect(label(key('l'))).toBe('Play')
    expect(label(key('ArrowLeft'))).toBe('Previous frame')
    expect(label(key('ArrowRight', { shiftKey: true }))).toBe('Forward 1 s')
    expect(label(key('s'))).toBe('Split at playhead')
    expect(label(key('Delete'))).toBe('Delete')
    expect(label(key('Backspace'))).toBe('Delete')
    expect(label(key('Backspace', { shiftKey: true }))).toBe('Ripple delete')
    expect(label(key('+', { shiftKey: true }))).toBe('Zoom in')
    expect(label(key('='))).toBe('Zoom in')
    expect(label(key('-'))).toBe('Zoom out')
    expect(label(key('Home'))).toBe('Go to start')
    expect(label(key('End'))).toBe('Go to end')
  })

  it('uses Ctrl on Windows/Linux and Cmd on macOS', () => {
    expect(label(key('z', { ctrlKey: true }))).toBe('Undo')
    expect(label(key('Z', { ctrlKey: true, shiftKey: true }))).toBe('Redo')
    expect(label(key('y', { ctrlKey: true }))).toBe('Redo')
    expect(label(key('d', { ctrlKey: true }))).toBe('Duplicate')
    expect(label(key('z', { metaKey: true }), true)).toBe('Undo')
    // The other platform's modifier never triggers editor commands.
    expect(label(key('z', { metaKey: true }))).toBeUndefined()
    expect(label(key('z', { ctrlKey: true }), true)).toBeUndefined()
  })

  it('does not treat Ctrl+S as split or plain keys as mod shortcuts', () => {
    expect(label(key('s', { ctrlKey: true }))).toBeUndefined()
    expect(label(key('d'))).toBeUndefined()
    expect(label(key('s', { altKey: true }))).toBeUndefined()
  })

  it('registered shortcuts take precedence and can be removed', () => {
    const run = vi.fn<Shortcut['run']>()
    const off = registerShortcut({ keys: ['s'], label: 'Custom split', run })
    expect(matchShortcut(key('s'))?.label).toBe('Custom split')
    off()
    expect(matchShortcut(key('s'))?.label).toBe('Split at playhead')
  })
})

describe('isTypingTarget', () => {
  it('detects text fields, contenteditable and open modals', () => {
    document.body.innerHTML = `
      <input id="i"><textarea id="t"></textarea><select id="s"></select>
      <div contenteditable="true"><span id="ce"></span></div>
      <div role="dialog" aria-modal="true"><button id="modal"></button></div>
      <button id="b"></button>`
    for (const id of ['i', 't', 's', 'ce', 'modal'])
      expect(isTypingTarget(document.getElementById(id))).toBe(true)
    expect(isTypingTarget(document.getElementById('b'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('createShortcutHandler', () => {
  let store: EditorStoreApi
  let handler: (e: KeyboardEvent) => void
  const press = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { key: k, cancelable: true, ...init })
    Object.defineProperty(e, 'target', { value: target })
    handler(e)
    return e
  }

  beforeEach(() => {
    store = createEditorStore()
    store.getState().load(makeProject())
    handler = createShortcutHandler(store)
    document.body.innerHTML = ''
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('drives the store and prevents the browser default', () => {
    const e = press(' ')
    expect(e.defaultPrevented).toBe(true)
    expect(store.getState().playing).toBe(true)
    press('k')
    expect(store.getState().playing).toBe(false)
    press('End')
    expect(store.getState().playhead).toBe(sec(5))
    press('ArrowLeft', { shiftKey: true })
    expect(store.getState().playhead).toBe(sec(4))
    press('Home')
    expect(store.getState().playhead).toBe(0)
    const z = store.getState().zoom
    press('=')
    expect(store.getState().zoom).toBeCloseTo(z * ZOOM_STEP)
  })

  it('undo / redo via keyboard', () => {
    store.getState().dispatch('Rename', (d) => {
      d.name = 'x'
    })
    press('z', { ctrlKey: true })
    expect(store.getState().project?.name).toBe('Test project')
    press('y', { ctrlKey: true })
    expect(store.getState().project?.name).toBe('x')
  })

  it('ignores keys typed into inputs', () => {
    const input = document.createElement('input')
    document.body.append(input)
    const e = press(' ', {}, input)
    expect(e.defaultPrevented).toBe(false)
    expect(store.getState().playing).toBe(false)
  })

  it('leaves Space to a focused button', () => {
    const btn = document.createElement('button')
    document.body.append(btn)
    press(' ', {}, btn)
    expect(store.getState().playing).toBe(false)
  })

  it('ignores already-handled, composing events and a closed editor', () => {
    const e = new KeyboardEvent('keydown', { key: ' ', cancelable: true })
    e.preventDefault()
    handler(e)
    handler(new KeyboardEvent('keydown', { key: ' ', isComposing: true }))
    expect(store.getState().playing).toBe(false)
    store.getState().unload()
    press(' ')
    expect(store.getState().playing).toBe(false)
  })
})
