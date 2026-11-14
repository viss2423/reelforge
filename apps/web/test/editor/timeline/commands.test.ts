/**
 * Non-drag timeline commands. Core ops are mocked with minimal draft mutations; the tests
 * check which op runs with which arguments, undo labels and failure toasts.
 */
import { OpError, sec, type MediaClip } from '@reelforge/core'
import type * as Core from '@reelforge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TRANSITIONS_TOOL,
  clipSpan,
  dropAsset,
  editFailure,
  nudgeClip,
  openTransition,
  runEdit,
  toggleCaptions,
  toggleTrackFlag,
  trackAccepts,
} from '@/editor/timeline/commands.ts'
import { createEditorStore, type EditorStoreApi } from '@/state/index.ts'
import { makeAsset } from '../../fixtures.ts'
import { clip, mainClips, project, track } from './helpers.ts'

const ops = vi.hoisted(() => ({
  moveClip: vi.fn<typeof Core.moveClip>(),
  insertMediaClip: vi.fn<typeof Core.insertMediaClip>(),
  insertAudioClip: vi.fn<typeof Core.insertAudioClip>(),
}))
const toast = vi.hoisted(() => vi.fn<(message: string, opts?: unknown) => void>())

vi.mock('@reelforge/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reelforge/core')>()),
  ...ops,
}))
vi.mock('@/components/Toast.tsx', () => ({ toast }))

let store: EditorStoreApi
const s = () => store.getState()

const base = () =>
  project(
    [
      track('main', mainClips(2, 2), 'main'),
      track('text', [clip('text', sec(1), sec(1), { id: 'tx' })], 'tt'),
      track('overlay', [clip('image', 0, sec(1), { id: 'img' })], 'ov', { locked: true }),
      track('audio', [], 'au'),
    ],
    { words: [{ text: 'hi', start: 0, end: sec(1) }] },
  )

beforeEach(() => {
  store = createEditorStore()
  s().load(base())
  ops.moveClip.mockImplementation(() => undefined)
  ops.insertMediaClip.mockImplementation((d, a) => {
    const c = clip('video', 0, sec(1), { id: 'new' }) as MediaClip
    d.tracks.find((t) => t.id === a.trackId)!.clips.splice(a.index ?? 0, 0, c)
    return c
  })
})

describe('editFailure / runEdit', () => {
  it('maps errors to user-facing reasons', () => {
    expect(editFailure(new OpError('too_short', 'Too short'))).toBe('Too short')
    expect(editFailure(new OpError('not_implemented', 'x'))).toBe('This edit is not available yet')
    expect(editFailure(new Error('boom'))).toBe('boom')
    expect(editFailure('raw')).toBe('raw')
  })

  it('toasts and leaves the project untouched when the op throws', () => {
    const before = s().project
    const ok = runEdit(store, 'Bad', () => {
      throw new OpError('locked', 'Track is locked')
    })
    expect(ok).toBe(false)
    expect(s().project).toBe(before)
    expect(toast).toHaveBeenCalledWith('Track is locked', { tone: 'error' })
  })
})

describe('trackAccepts', () => {
  it('mirrors the core placement rule', () => {
    expect(trackAccepts('main', 'video')).toBe(true)
    expect(trackAccepts('main', 'sticker')).toBe(false)
    expect(trackAccepts('overlay', 'sticker')).toBe(true)
    expect(trackAccepts('text', 'text')).toBe(true)
    expect(trackAccepts('text', 'video')).toBe(false)
    expect(trackAccepts('audio', 'audio')).toBe(true)
  })
})

describe('nudgeClip', () => {
  it('moves free clips by whole frames and never before 0', () => {
    expect(nudgeClip(store, 'tx', 3)).toBe(true)
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['tx', { start: 1_100_000 }])
    expect(nudgeClip(store, 'tx', -100)).toBe(true)
    expect(ops.moveClip.mock.calls[1]!.slice(1)).toEqual(['tx', { start: 0 }])
  })

  it('moves main clips by one slot and stops at the ends', () => {
    expect(nudgeClip(store, 'm0', -1)).toBe(false)
    expect(nudgeClip(store, 'm1', 10)).toBe(false)
    expect(nudgeClip(store, 'm1', -10)).toBe(true)
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['m1', { index: 0 }])
  })

  it('refuses locked tracks, unknown clips and zero nudges', () => {
    expect(nudgeClip(store, 'img', 1)).toBe(false)
    expect(toast).toHaveBeenCalledWith('Track is locked')
    expect(nudgeClip(store, 'nope', 1)).toBe(false)
    expect(nudgeClip(store, 'tx', 0)).toBe(false)
    expect(ops.moveClip).not.toHaveBeenCalled()
  })
})

describe('track flags and captions', () => {
  it('toggles flags with descriptive undo labels', () => {
    toggleTrackFlag(store, 'tt', 'hidden')
    expect(s().project!.tracks[1]!.hidden).toBe(true)
    expect(s().history.undoLabel).toBe('Hide track')
    toggleTrackFlag(store, 'tt', 'hidden')
    expect(s().history.undoLabel).toBe('Show track')
    toggleTrackFlag(store, 'missing', 'muted')
    expect(s().history.undoLabel).toBe('Show track')
  })

  it('toggles burned-in captions', () => {
    toggleCaptions(store)
    expect(s().project!.captions!.enabled).toBe(false)
    toggleCaptions(store)
    expect(s().project!.captions!.enabled).toBe(true)
  })
})

describe('dropAsset', () => {
  it('inserts visual assets on the main track at the nearest boundary and selects them', () => {
    const asset = makeAsset({ kind: 'video' })
    dropAsset(store, asset, undefined, sec(3.2))
    expect(ops.insertMediaClip.mock.calls[0]![1]).toMatchObject({ trackId: 'main', index: 2 })
    expect(s().selection.clipIds).toEqual(['new'])
  })

  it('refuses assets that are still processing', () => {
    dropAsset(store, makeAsset({ kind: 'video', duration: undefined }), 'main', 0)
    expect(ops.insertMediaClip).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('still being processed'))
  })

  it('places assets on other tracks at the frame-snapped drop time', () => {
    ops.insertMediaClip.mockClear()
    dropAsset(store, makeAsset({ kind: 'image' }), 'ov2', sec(1.01))
    // Unknown track: addAssetToTimeline passes it through to core.
    expect(ops.insertMediaClip.mock.calls[0]![1]).toMatchObject({ trackId: 'ov2', at: 1_000_000 })
  })

  it('routes audio to the audio insert op', () => {
    ops.insertAudioClip.mockImplementation((d, a) => {
      const c = clip('audio', a.at, sec(1), { id: 'aud1' }) as Core.AudioClip
      d.tracks.find((t) => t.id === 'au')!.clips.push(c)
      return c
    })
    dropAsset(
      store,
      makeAsset({ kind: 'audio', mime: 'audio/mpeg', hasVideo: false }),
      'au',
      sec(2),
    )
    expect(ops.insertAudioClip.mock.calls[0]![1]).toMatchObject({ trackId: 'au', at: sec(2) })
  })
})

describe('openTransition / clipSpan', () => {
  it('selects the clip and activates the transitions tool', () => {
    openTransition(store, 'm1', 'main')
    expect(s().selection.clipIds).toEqual(['m1'])
    expect(s().activeTool).toBe(TRANSITIONS_TOOL)
  })

  it('returns playback spans', () => {
    expect(clipSpan(s().project!, 'm1')).toEqual({ start: sec(2), end: sec(4) })
    expect(clipSpan(s().project!, 'nope')).toBeNull()
  })
})
