/**
 * Editor commands against the REAL core ops (no mocks): every command runs its op on an
 * Immer draft through `dispatch`, produces a schema-valid project and undoes in one step.
 * `actions.test.ts` covers command wiring with mocked ops; this suite proves the pairing
 * with core actually works.
 */
import { Project, projectDuration, sec, validateProject } from '@reelforge/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addAssetToTimeline,
  deleteSelection,
  duplicateSelection,
  splitAtPlayhead,
} from '@/editor/actions.ts'
import { createEditorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { clipIds, makeAsset, makeProject } from '../fixtures.ts'

let store: EditorStoreApi
const s = () => store.getState()
const project = (): Project => {
  const p = s().project
  if (!p) throw new Error('no project')
  return p
}
const main = () => project().tracks.find((t) => t.kind === 'main')!.clips

/** Valid against the zod schema and free of validation issues. */
const expectValid = () => {
  expect(() => Project.parse(project())).not.toThrow()
  expect(validateProject(project())).toEqual([])
}

beforeEach(() => {
  store = createEditorStore()
  // main: [0,2s) [2s,5s), plus empty text and audio tracks.
  s().load(makeProject())
})

describe('editor commands with real core ops', () => {
  it('inserts a video at the playhead boundary and ripples the main track', () => {
    s().setPlayhead(sec(1))
    const asset = makeAsset({ duration: sec(4) })
    const r = addAssetToTimeline(store, asset)
    expect(r.ok).toBe(true)
    expect(main().map((c) => [c.start, c.duration])).toEqual([
      [0, sec(2)],
      [sec(2), sec(4)],
      [sec(6), sec(3)],
    ])
    expect(main()[1]).toMatchObject({ id: r.ok ? r.clipId : '', assetId: asset.id })
    expect(projectDuration(project())).toBe(sec(9))
    expectValid()
    s().undo()
    expect(main()).toHaveLength(2)
  })

  it('appends imports at the end and puts audio on the audio track', () => {
    addAssetToTimeline(store, makeAsset({ duration: sec(1) }), { position: 'end' })
    expect(main().at(-1)).toMatchObject({ start: sec(5), duration: sec(1) })
    const music = makeAsset({ kind: 'audio', hasVideo: false, duration: sec(3) })
    s().setPlayhead(sec(2))
    expect(addAssetToTimeline(store, music).ok).toBe(true)
    const audio = project().tracks.find((t) => t.kind === 'audio')!.clips
    expect(audio).toEqual([expect.objectContaining({ assetId: music.id, start: sec(2) })])
    expectValid()
  })

  it('reports an op failure as a reason and leaves the project untouched', () => {
    const before = s().project
    // A video track id that does not exist.
    const r = addAssetToTimeline(store, makeAsset(), { trackId: 'nope' })
    expect(r.ok).toBe(false)
    expect(s().project).toBe(before)
  })

  it('splits the clip under the playhead into two contiguous clips', () => {
    s().setPlayhead(sec(3))
    expect(splitAtPlayhead(store)).toEqual({ ok: true })
    expect(main().map((c) => [c.start, c.duration])).toEqual([
      [0, sec(2)],
      [sec(2), sec(1)],
      [sec(3), sec(2)],
    ])
    expect(projectDuration(project())).toBe(sec(5))
    expectValid()
    s().undo()
    expect(main()).toHaveLength(2)
  })

  it('duplicates and deletes the selection (main track stays gapless)', () => {
    const original = clipIds(project())
    const first = original[0]!
    s().select([first])
    expect(duplicateSelection(store)).toEqual({ ok: true })
    expect(main()).toHaveLength(3)
    expect(projectDuration(project())).toBe(sec(7))
    const copy = s().selection.clipIds[0]!
    expect(copy).not.toBe(first)

    expect(deleteSelection(store)).toEqual({ ok: true })
    expect(main().map((c) => [c.start, c.duration])).toEqual([
      [0, sec(2)],
      [sec(2), sec(3)],
    ])
    expectValid()
    s().undo()
    s().undo()
    expect(clipIds(project())).toEqual(original)
  })
})
