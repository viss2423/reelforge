import { sec } from '@reelforge/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  ZOOM_MAX,
  ZOOM_MIN,
  createEditorStore,
  type EditorStoreApi,
  type ProjectChange,
} from '@/state/editorStore.ts'
import { clipIds, makeAsset, makeProject, videoClip } from '../fixtures.ts'

let now = 0
let store: EditorStoreApi
const s = () => store.getState()

beforeEach(() => {
  now = 10_000
  store = createEditorStore(() => now)
  s().load(makeProject())
})

const rename = (name: string) =>
  s().dispatch(`Rename ${name}`, (d) => {
    d.name = name
  })

describe('load / unload', () => {
  it('deep-freezes the project and resets editor state', () => {
    s().setPlayhead(sec(3))
    s().select(['x'])
    s().load(makeProject({ revision: 7 }))
    expect(Object.isFrozen(s().project)).toBe(true)
    expect(Object.isFrozen(s().project?.tracks[0]?.clips[0])).toBe(true)
    expect(s().playhead).toBe(0)
    expect(s().selection.clipIds).toEqual([])
    expect(s().sync.revision).toBe(7)
    expect(s().history.canUndo).toBe(false)
  })

  it('keeps assets when none are passed and replaces them when given', () => {
    const a = makeAsset({ id: 'a1' })
    s().load(makeProject(), [a])
    expect(s().assets.a1).toBe(a)
    s().load(makeProject())
    expect(s().assets.a1).toBe(a)
  })

  it('unload clears everything', () => {
    rename('x')
    s().unload()
    expect(s().project).toBeNull()
    expect(s().history.canUndo).toBe(false)
  })
})

describe('dispatch', () => {
  it('applies the recipe immutably and records one undo step', () => {
    const before = s().project
    rename('Renamed')
    expect(s().project?.name).toBe('Renamed')
    expect(before?.name).toBe('Test project')
    expect(s().history).toEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: 'Rename Renamed',
      redoLabel: null,
    })
  })

  it('keeps structural sharing for untouched tracks and clips', () => {
    const before = s().project!
    s().dispatch('Rename text track', (d) => {
      d.tracks[1]!.name = 'Titles'
    })
    const after = s().project!
    expect(after.tracks[0]).toBe(before.tracks[0])
    expect(after.tracks[2]).toBe(before.tracks[2])
    expect(after.tracks[1]).not.toBe(before.tracks[1])
  })

  it('returns plain snapshots for draft results (single and arrays)', () => {
    const clip = s().dispatch('Add', (d) => {
      const c = videoClip(sec(5), sec(1))
      d.tracks[0]!.clips.push(c)
      return d.tracks[0]!.clips.at(-1)!
    })
    // Using a revoked draft would throw; a snapshot is readable after produce.
    expect(clip.start).toBe(sec(5))
    const pair = s().dispatch('Pair', (d) => [d.tracks[0]!.clips[0]!, d.tracks[0]!.clips[1]!])
    expect(pair.map((c) => c.start)).toEqual([0, sec(2)])
  })

  it('does not record no-op recipes', () => {
    s().dispatch('Nothing', () => undefined)
    expect(s().history.canUndo).toBe(false)
  })

  it('leaves the project untouched when the recipe throws', () => {
    const before = s().project
    expect(() =>
      s().dispatch('Boom', (d) => {
        d.name = 'half-done'
        throw new Error('nope')
      }),
    ).toThrow('nope')
    expect(s().project).toBe(before)
    expect(s().history.canUndo).toBe(false)
  })

  it('throws without a loaded project', () => {
    s().unload()
    expect(() => rename('x')).toThrow(/without a loaded project/)
  })

  it('clears the redo stack on a new edit', () => {
    rename('a')
    s().undo()
    expect(s().history.canRedo).toBe(true)
    rename('b')
    expect(s().history.canRedo).toBe(false)
  })

  it('caps history at HISTORY_LIMIT entries', () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) rename(`n${i}`)
    let undos = 0
    while (s().history.canUndo) {
      s().undo()
      undos++
    }
    expect(undos).toBe(HISTORY_LIMIT)
    expect(s().project?.name).toBe('n19')
  })

  it('prunes selection of clips that no longer exist', () => {
    const [first] = clipIds(s().project)
    s().select([first!, 'ghost'], { trackId: 'main' })
    s().dispatch('Delete', (d) => {
      d.tracks[0]!.clips.shift()
    })
    expect(s().selection.clipIds).toEqual([])
    expect(s().selection.trackId).toBe('main')
  })
})

describe('coalescing', () => {
  it('merges same-key dispatches within the window into one step', () => {
    s().dispatch('Type', (d) => void (d.name = 'a'), { coalesce: 'name' })
    now += COALESCE_MS - 1
    s().dispatch('Type', (d) => void (d.name = 'ab'), { coalesce: 'name' })
    now += COALESCE_MS - 1
    s().dispatch('Type', (d) => void (d.name = 'abc'), { coalesce: 'name' })
    s().undo()
    expect(s().project?.name).toBe('Test project')
    expect(s().history.canUndo).toBe(false)
    s().redo()
    expect(s().project?.name).toBe('abc')
  })

  it('starts a new step after the window or with another key', () => {
    s().dispatch('Type', (d) => void (d.name = 'a'), { coalesce: 'name' })
    now += COALESCE_MS + 1
    s().dispatch('Type', (d) => void (d.name = 'ab'), { coalesce: 'name' })
    s().dispatch('Other', (d) => void (d.name = 'abc'), { coalesce: 'other' })
    s().undo()
    expect(s().project?.name).toBe('ab')
    s().undo()
    expect(s().project?.name).toBe('a')
  })
})

describe('undo / redo', () => {
  it('round-trips multiple edits', () => {
    rename('a')
    rename('b')
    s().undo()
    expect(s().project?.name).toBe('a')
    expect(s().history.redoLabel).toBe('Rename b')
    s().undo()
    expect(s().project?.name).toBe('Test project')
    s().undo() // no-op at the bottom
    s().redo()
    s().redo()
    s().redo() // no-op at the top
    expect(s().project?.name).toBe('b')
  })

  it('clears history when patches no longer apply (remote replacement)', () => {
    s().dispatch('Move', (d) => {
      d.tracks[1]!.clips.push(videoClip(0, sec(1)))
    })
    s().replaceProject(makeProject({ tracks: [{ id: 'main', kind: 'main', clips: [] }] }))
    s().undo()
    expect(s().history.canUndo).toBe(false)
    expect(s().project?.tracks).toHaveLength(1)
  })
})

describe('transactions', () => {
  const nudge = (dx: number) =>
    s().dispatch('Nudge', (d) => {
      d.tracks[0]!.clips[1]!.start += dx
    })

  it('groups a gesture into one undo step and one change event', () => {
    const changes: ProjectChange[] = []
    s().subscribeChanges((c) => changes.push(c))
    s().beginTransaction('Drag clip')
    expect(s().transaction).toBe('Drag clip')
    for (let i = 0; i < 50; i++) nudge(10)
    expect(changes).toHaveLength(0)
    s().commitTransaction()
    expect(s().transaction).toBeNull()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ label: 'Drag clip', source: 'transaction' })
    expect(s().project?.tracks[0]?.clips[1]?.start).toBe(sec(2) + 500)
    s().undo()
    expect(s().project?.tracks[0]?.clips[1]?.start).toBe(sec(2))
    s().redo()
    expect(s().project?.tracks[0]?.clips[1]?.start).toBe(sec(2) + 500)
  })

  it('cancel reverts every step of the gesture without history', () => {
    rename('kept')
    const before = s().project
    s().beginTransaction('Drag')
    nudge(100)
    nudge(100)
    s().cancelTransaction()
    expect(s().project).toEqual(before)
    expect(s().history.undoLabel).toBe('Rename kept')
  })

  it('an empty transaction records nothing', () => {
    s().beginTransaction('Tap')
    s().commitTransaction()
    expect(s().history.canUndo).toBe(false)
  })

  it('undo during a gesture cancels the gesture only', () => {
    rename('kept')
    s().beginTransaction('Drag')
    nudge(100)
    s().undo()
    expect(s().transaction).toBeNull()
    expect(s().project?.name).toBe('kept')
    expect(s().project?.tracks[0]?.clips[1]?.start).toBe(sec(2))
  })

  it('beginning a new transaction commits the open one', () => {
    s().beginTransaction('A')
    nudge(1)
    s().beginTransaction('B')
    nudge(1)
    s().commitTransaction()
    expect(s().history.undoLabel).toBe('B')
    s().undo()
    expect(s().history.undoLabel).toBe('A')
  })

  it('redo is ignored mid-gesture', () => {
    rename('a')
    s().undo()
    s().beginTransaction('Drag')
    s().redo()
    expect(s().project?.name).toBe('Test project')
    s().cancelTransaction()
  })
})

describe('change events', () => {
  it('reports dispatch, undo and redo with their patches', () => {
    const changes: ProjectChange[] = []
    const off = s().subscribeChanges((c) => changes.push(c))
    rename('x')
    s().undo()
    s().redo()
    off()
    rename('y')
    expect(changes.map((c) => c.source)).toEqual(['dispatch', 'undo', 'redo'])
    expect(changes[1]?.patches).toEqual(changes[0]?.inversePatches)
  })

  it('replaceProject and setRevision do not emit', () => {
    const changes: ProjectChange[] = []
    s().subscribeChanges((c) => changes.push(c))
    s().setRevision(9)
    s().replaceProject(makeProject({ name: 'remote' }))
    expect(changes).toEqual([])
    expect(s().sync.revision).toBe(9)
  })
})

describe('UI state', () => {
  it('selection helpers', () => {
    s().select(['a'], { trackId: 't' })
    s().select(['b', 'a'], { additive: true })
    expect(s().selection).toEqual({ clipIds: ['a', 'b'], trackId: 't' })
    s().toggleSelect('a')
    expect(s().selection.clipIds).toEqual(['b'])
    s().toggleSelect('c')
    expect(s().selection.clipIds).toEqual(['b', 'c'])
    s().selectTrack(null)
    expect(s().selection.trackId).toBeNull()
    s().clearSelection()
    expect(s().selection.clipIds).toEqual([])
  })

  it('playhead is a non-negative integer and tracks its source', () => {
    s().setPlayhead(-5)
    expect(s().playhead).toBe(0)
    s().setPlayhead(1234.6, 'engine')
    expect(s().playhead).toBe(1235)
    expect(s().playheadSource).toBe('engine')
  })

  it('does not notify subscribers for redundant updates', () => {
    let calls = 0
    store.subscribe(() => calls++)
    s().setPlayhead(0)
    s().setPlaying(false)
    s().clearSelection()
    expect(calls).toBe(0)
  })

  it('zoom is clamped', () => {
    s().setZoom(1e9)
    expect(s().zoom).toBe(ZOOM_MAX)
    s().zoomBy(1e-9)
    expect(s().zoom).toBe(ZOOM_MIN)
  })

  it('playing, scroll, tool and panel setters', () => {
    s().togglePlaying()
    expect(s().playing).toBe(true)
    s().setScroll({ x: 10 })
    s().setScroll({ y: 4 })
    expect(s().scroll).toEqual({ x: 10, y: 4 })
    s().setActiveTool('split')
    s().setActivePanel('text')
    expect([s().activeTool, s().activePanel]).toEqual(['split', 'text'])
  })

  it('asset map helpers keep identity when unchanged', () => {
    const a = makeAsset({ id: 'a1' })
    s().setAssets([a])
    const map = s().assets
    s().upsertAsset(a)
    expect(s().assets).toBe(map)
    const b = { ...a, proxy: 'ready' as const, name: 'renamed' }
    s().upsertAsset(b)
    expect(s().assets.a1).toBe(b)
    s().removeAsset('missing')
    s().removeAsset('a1')
    expect(s().assets).toEqual({})
  })
})
