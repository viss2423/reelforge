/**
 * Editor commands. Core timeline ops are mocked with minimal draft mutations: these tests
 * cover how commands drive the store (targets, undo steps, selection, error mapping), not
 * the ops themselves (core has its own suite).
 */
import { OpError, sec, type AudioClip, type MediaClip, type Project } from '@reelforge/core'
import type * as Core from '@reelforge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import {
  addAssetToTimeline,
  deleteSelection,
  duplicateSelection,
  isAssetPlaceable,
  mainInsertIndex,
  seekBy,
  splitAtPlayhead,
  stepFrames,
} from '@/editor/actions.ts'
import { clipIds, makeAsset, makeProject, videoClip } from '../fixtures.ts'

const ops = vi.hoisted(() => ({
  insertMediaClip: vi.fn<typeof Core.insertMediaClip>(),
  insertAudioClip: vi.fn<typeof Core.insertAudioClip>(),
  splitClip: vi.fn<typeof Core.splitClip>(),
  deleteClips: vi.fn<typeof Core.deleteClips>(),
  duplicateClip: vi.fn<typeof Core.duplicateClip>(),
}))

vi.mock('@reelforge/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reelforge/core')>()),
  ...ops,
}))

const track = (p: Project, id: string) => p.tracks.find((t) => t.id === id)!

let store: EditorStoreApi
const s = () => store.getState()

beforeEach(() => {
  store = createEditorStore()
  s().load(makeProject())
  let n = 0
  ops.insertMediaClip.mockImplementation((d, a) => {
    const clip = videoClip(a.at ?? 0, sec(1), { id: `new${++n}` }) as MediaClip
    track(d, a.trackId).clips.splice(a.index ?? 0, 0, clip)
    return clip
  })
  ops.insertAudioClip.mockImplementation((d, a) => {
    const clip = { ...videoClip(a.at, sec(1), { id: `aud${++n}` }), type: 'audio' } as AudioClip
    track(d, 'audio').clips.push(clip)
    return clip
  })
  ops.splitClip.mockImplementation((d, id, t) => {
    for (const tr of d.tracks) {
      const i = tr.clips.findIndex((c) => c.id === id)
      if (i === -1) continue
      const c = tr.clips[i]!
      const right = { ...c, id: `${id}-r`, start: t, duration: c.start + c.duration - t }
      c.duration = t - c.start
      tr.clips.splice(i + 1, 0, right)
      return [c, right]
    }
    throw new OpError('not_found', `no clip ${id}`)
  })
  ops.deleteClips.mockImplementation((d, ids) => {
    for (const tr of d.tracks) tr.clips = tr.clips.filter((c) => !ids.includes(c.id))
  })
  ops.duplicateClip.mockImplementation((d, id) => {
    const tr = d.tracks.find((t) => t.clips.some((c) => c.id === id))!
    const c = tr.clips.find((x) => x.id === id)!
    const copy = { ...c, id: `${id}-copy` }
    tr.clips.push(copy)
    return copy
  })
})

describe('isAssetPlaceable', () => {
  it('needs a probed duration for video/audio, nothing for images', () => {
    expect(isAssetPlaceable(makeAsset({ kind: 'image', duration: undefined }))).toBe(true)
    expect(isAssetPlaceable(makeAsset({ duration: undefined }))).toBe(false)
    expect(isAssetPlaceable(makeAsset({ duration: 0 }))).toBe(false)
    expect(isAssetPlaceable(makeAsset({ duration: 5 }))).toBe(true)
  })
})

describe('mainInsertIndex', () => {
  it('inserts before a clip starting at/after the playhead or after the clip under it', () => {
    const p = makeProject() // main: [0,2s) [2s,5s)
    expect(mainInsertIndex(p, 0)).toBe(0)
    expect(mainInsertIndex(p, sec(1))).toBe(1)
    expect(mainInsertIndex(p, sec(2))).toBe(1)
    expect(mainInsertIndex(p, sec(3))).toBe(2)
    expect(mainInsertIndex(p, sec(10))).toBe(2)
  })
})

describe('addAssetToTimeline', () => {
  it('inserts visuals on the main track at the playhead as one undo step and selects them', () => {
    s().setPlayhead(sec(3))
    const r = addAssetToTimeline(store, makeAsset())
    expect(r).toMatchObject({ ok: true, clipId: 'new1' })
    expect(ops.insertMediaClip.mock.calls[0]?.[1]).toMatchObject({ trackId: 'main', index: 2 })
    expect(clipIds(s().project).at(-1)).toBe('new1')
    expect(s().selection.clipIds).toEqual(['new1'])
    expect(s().history.undoLabel).toBe('Add video')
    s().undo()
    expect(clipIds(s().project)).not.toContain('new1')
  })

  it("appends with position 'end'", () => {
    addAssetToTimeline(store, makeAsset(), { position: 'end' })
    expect(ops.insertMediaClip.mock.calls[0]?.[1]).toMatchObject({ index: 2 })
  })

  it('places on another track at a time when a track is given', () => {
    addAssetToTimeline(store, makeAsset(), { trackId: 'text', at: sec(1) })
    expect(ops.insertMediaClip.mock.calls[0]?.[1]).toMatchObject({ trackId: 'text', at: sec(1) })
  })

  it('puts audio on an audio track at the playhead or the end', () => {
    s().setPlayhead(sec(1))
    addAssetToTimeline(store, makeAsset({ kind: 'audio' }))
    expect(ops.insertAudioClip.mock.calls[0]?.[1]).toMatchObject({ at: sec(1) })
    addAssetToTimeline(store, makeAsset({ kind: 'audio' }), { position: 'end' })
    // End = end of the furthest clip, including the audio just added (1s..2s) → main's 5s.
    expect(ops.insertAudioClip.mock.calls[1]?.[1]).toMatchObject({ at: sec(5) })
  })

  it('refuses assets that are still processing', () => {
    const r = addAssetToTimeline(store, makeAsset({ name: 'raw.mov', duration: undefined }))
    expect(r).toEqual({ ok: false, reason: 'raw.mov is still being processed' })
    expect(ops.insertMediaClip).not.toHaveBeenCalled()
  })

  it('maps op errors to user-facing reasons and leaves the project untouched', () => {
    const before = s().project
    ops.insertMediaClip.mockImplementationOnce(() => {
      throw new OpError('not_implemented', 'x')
    })
    expect(addAssetToTimeline(store, makeAsset())).toEqual({
      ok: false,
      reason: 'This edit is not available yet',
    })
    ops.insertMediaClip.mockImplementationOnce(() => {
      throw new OpError('overlap', 'Clips would overlap')
    })
    expect(addAssetToTimeline(store, makeAsset())).toEqual({
      ok: false,
      reason: 'Clips would overlap',
    })
    expect(s().project).toBe(before)
  })

  it('fails without a project or main track', () => {
    s().load(makeProject({ tracks: [{ id: 'text', kind: 'text' }] }))
    expect(addAssetToTimeline(store, makeAsset())).toMatchObject({ ok: false })
    s().unload()
    expect(addAssetToTimeline(store, makeAsset())).toEqual({ ok: false, reason: 'No project open' })
  })
})

describe('split / delete / duplicate', () => {
  it('splits the main clip under the playhead when nothing is selected', () => {
    s().setPlayhead(sec(3))
    const [, second] = clipIds(s().project)
    expect(splitAtPlayhead(store)).toEqual({ ok: true })
    // Draft args are revoked after dispatch, so compare only the plain arguments.
    expect(ops.splitClip.mock.calls[0]?.slice(1)).toEqual([second, sec(3)])
    expect(s().history.undoLabel).toBe('Split')
  })

  it('splits the selected clips under the playhead', () => {
    s().dispatch('seed', (d) => {
      track(d, 'text').clips.push(videoClip(0, sec(4), { id: 'title' }))
    })
    s().select(['title'])
    s().setPlayhead(sec(1))
    splitAtPlayhead(store)
    expect(ops.splitClip.mock.calls.map((c) => c[1])).toEqual(['title'])
  })

  it('refuses to split at a clip boundary or past the end', () => {
    s().setPlayhead(sec(2))
    expect(splitAtPlayhead(store)).toMatchObject({ ok: false })
    s().setPlayhead(sec(9))
    expect(splitAtPlayhead(store)).toMatchObject({ ok: false })
    expect(ops.splitClip).not.toHaveBeenCalled()
  })

  it('deletes the selection (ripple flag passed through) and clears it', () => {
    const [first, second] = clipIds(s().project)
    s().select([first!, second!])
    expect(deleteSelection(store, true)).toEqual({ ok: true })
    expect(ops.deleteClips.mock.calls[0]?.slice(1)).toEqual([[first, second], { ripple: true }])
    expect(s().history.undoLabel).toBe('Delete 2 clips')
    expect(s().selection.clipIds).toEqual([])
    expect(deleteSelection(store)).toEqual({ ok: false, reason: 'Nothing selected' })
  })

  it('duplicates the selection and selects the copies', () => {
    const [first] = clipIds(s().project)
    s().select([first!])
    expect(duplicateSelection(store)).toEqual({ ok: true })
    expect(s().selection.clipIds).toEqual([`${first}-copy`])
    s().clearSelection()
    expect(duplicateSelection(store)).toMatchObject({ ok: false })
  })
})

describe('playhead commands', () => {
  it('steps whole frames on the project frame grid, clamped, and pauses', () => {
    s().setPlaying(true)
    stepFrames(store, 1)
    expect(s().playhead).toBe(33_333)
    expect(s().playing).toBe(false)
    stepFrames(store, 2)
    expect(s().playhead).toBe(100_000)
    stepFrames(store, -100)
    expect(s().playhead).toBe(0)
    stepFrames(store, 10_000)
    expect(s().playhead).toBe(sec(5))
  })

  it('seekBy clamps to the timeline', () => {
    seekBy(store, sec(1))
    expect(s().playhead).toBe(sec(1))
    seekBy(store, sec(-10))
    expect(s().playhead).toBe(0)
    seekBy(store, sec(60))
    expect(s().playhead).toBe(sec(5))
  })
})
