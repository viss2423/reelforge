import { sec, type Project } from '@reelforge/core'
import { produce } from 'immer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, RevisionConflict, type ApiClient } from '@/api/client.ts'
import { createEditorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import {
  createProjectSync,
  type DraftRecord,
  type DraftStore,
  type ProjectSync,
  type SyncNotice,
} from '@/state/sync.ts'
import { makeProject } from '../fixtures.ts'

const DEVICE = 'dev-A'

/** In-memory host: holds the authoritative project and enforces revisions like the server. */
class FakeHost {
  project: Project
  saves: Array<{ expectedRevision: number; deviceId: string; project: Project }> = []
  failNext: unknown[] = []
  /** Holds the next save until the function returned by `hold()` is called. */
  gate: { promise: Promise<void>; release: () => void } | null = null

  constructor(p: Project) {
    this.project = p
  }

  hold() {
    let release!: () => void
    const promise = new Promise<void>((r) => (release = r))
    this.gate = { promise, release }
    return release
  }

  /** Another device saves `recipe(project)`. */
  remoteEdit(recipe: (d: Project) => void) {
    this.project = produce(this.project, (d) => {
      recipe(d)
      d.revision += 1
    })
  }

  api = {
    saveProject: vi.fn<ApiClient['saveProject']>(async (project, expectedRevision, deviceId) => {
      this.saves.push({ project, expectedRevision, deviceId })
      if (this.gate) {
        const g = this.gate
        this.gate = null
        await g.promise
      }
      const err = this.failNext.shift()
      if (err) throw err
      if (expectedRevision !== this.project.revision) throw new RevisionConflict(this.project)
      this.project = { ...project, revision: expectedRevision + 1 }
      return this.project.revision
    }),
    project: vi.fn<ApiClient['project']>(async () => this.project),
  }
}

class MemoryDrafts implements DraftStore {
  map = new Map<string, DraftRecord>()
  get = vi.fn<DraftStore['get']>(async (id) => this.map.get(id))
  set = vi.fn<DraftStore['set']>(async (id, rec) => void this.map.set(id, rec))
  delete = vi.fn<DraftStore['delete']>(async (id) => void this.map.delete(id))
}

let store: EditorStoreApi
let host: FakeHost
let drafts: MemoryDrafts
let notices: SyncNotice[]
let online: boolean
let win: EventTarget
let sync: ProjectSync

const s = () => store.getState()
const rename = (name: string) =>
  s().dispatch('Rename', (d) => {
    d.name = name
  })

const start = (extra: Partial<Parameters<typeof createProjectSync>[0]> = {}) => {
  sync = createProjectSync({
    store,
    api: host.api,
    deviceId: DEVICE,
    drafts,
    isOnline: () => online,
    onNotice: (n) => notices.push(n),
    win: win as unknown as Window,
    doc: undefined,
    ...extra,
  })
  return sync
}

beforeEach(() => {
  vi.useFakeTimers()
  const p = makeProject({ revision: 1 })
  store = createEditorStore()
  s().load(p)
  host = new FakeHost(p)
  drafts = new MemoryDrafts()
  notices = []
  online = true
  win = new EventTarget()
})

afterEach(() => {
  sync?.dispose()
  vi.useRealTimers()
})

describe('autosave', () => {
  it('debounces edits into one PUT with expectedRevision and deviceId', async () => {
    start()
    rename('a')
    await vi.advanceTimersByTimeAsync(300)
    rename('b')
    expect(s().sync.status).toBe('pending')
    expect(sync.pending).toBe(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(host.saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.saves).toHaveLength(1)
    expect(host.saves[0]).toMatchObject({ expectedRevision: 1, deviceId: DEVICE })
    expect(host.saves[0]?.project.name).toBe('b')
    await vi.runAllTimersAsync()
    expect(s().sync).toMatchObject({ status: 'saved', revision: 2, error: null })
    expect(s().project?.revision).toBe(2)
    expect(sync.pending).toBe(false)
  })

  it('never saves mid-gesture; saves once after commit', async () => {
    start()
    s().beginTransaction('Drag')
    for (let i = 0; i < 10; i++) {
      s().dispatch('Nudge', (d) => {
        d.tracks[0]!.clips[1]!.start += 1
      })
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(host.saves).toHaveLength(0)
    s().commitTransaction()
    await vi.runAllTimersAsync()
    expect(host.saves).toHaveLength(1)
    expect(host.saves[0]?.project.tracks[0]?.clips[1]?.start).toBe(sec(2) + 10)
  })

  it('saves undo/redo as edits too', async () => {
    start()
    rename('a')
    await vi.runAllTimersAsync()
    s().undo()
    await vi.runAllTimersAsync()
    expect(host.project.name).toBe('Test project')
    expect(host.saves.map((x) => x.expectedRevision)).toEqual([1, 2])
  })

  it('edits made while a save is in flight are sent in a follow-up save', async () => {
    start()
    const release = host.hold()
    rename('first')
    await vi.advanceTimersByTimeAsync(500)
    expect(host.saves).toHaveLength(1)
    rename('second')
    release()
    await vi.runAllTimersAsync()
    expect(host.saves).toHaveLength(2)
    expect(host.saves[1]).toMatchObject({ expectedRevision: 2 })
    expect(host.project.name).toBe('second')
    expect(s().sync.status).toBe('saved')
  })

  it('ignores edits once another project is loaded', async () => {
    start()
    s().load(makeProject({ id: 'other' }))
    rename('x')
    await vi.runAllTimersAsync()
    expect(host.saves).toHaveLength(0)
  })
})

describe('409 conflict → rebase', () => {
  it('re-applies local unsaved edits on top of the server project', async () => {
    start()
    host.remoteEdit((d) => {
      d.tracks[1]!.name = 'Remote titles'
    })
    rename('Local name')
    await vi.runAllTimersAsync()
    expect(notices).toEqual(['merged'])
    // First PUT conflicted (expected 1, server at 2); the rebased save succeeded.
    expect(host.saves.map((x) => x.expectedRevision)).toEqual([1, 2])
    expect(host.project).toMatchObject({ name: 'Local name', revision: 3 })
    expect(host.project.tracks[1]?.name).toBe('Remote titles')
    expect(s().project?.tracks[1]?.name).toBe('Remote titles')
    expect(s().sync).toMatchObject({ status: 'saved', revision: 3 })
  })

  it('adopts the server version when local patches no longer apply', async () => {
    start()
    s().dispatch('Edit clip', (d) => {
      d.tracks[0]!.clips[1]!.name = 'mine'
    })
    host.remoteEdit((d) => {
      d.tracks = [d.tracks[0]!]
      d.tracks[0]!.clips = []
    })
    await vi.runAllTimersAsync()
    expect(notices).toEqual(['local-discarded'])
    expect(s().project?.tracks).toHaveLength(1)
    expect(s().project?.tracks[0]?.clips).toEqual([])
    expect(s().sync).toMatchObject({ status: 'saved', revision: 2 })
    expect(host.saves).toHaveLength(1)
    expect(drafts.delete).toHaveBeenCalledWith('p1')
  })

  it('adopts the server version when the rebased project fails validation', async () => {
    start({ validate: () => false })
    host.remoteEdit((d) => {
      d.name = 'remote'
    })
    rename('local')
    await vi.runAllTimersAsync()
    expect(notices).toEqual(['local-discarded'])
    expect(s().project?.name).toBe('remote')
  })
})

describe('live sync', () => {
  it('fetches and applies another device’s revision', async () => {
    start()
    host.remoteEdit((d) => {
      d.name = 'from phone'
    })
    await sync.onRemoteRevision(2, 'dev-B')
    expect(host.api.project).toHaveBeenCalledWith('p1')
    expect(s().project?.name).toBe('from phone')
    expect(s().sync.revision).toBe(2)
    expect(notices).toEqual(['remote-applied'])
    expect(s().history.canUndo).toBe(false)
  })

  it('ignores its own echo and stale revisions', async () => {
    start()
    await sync.onRemoteRevision(5, DEVICE)
    await sync.onRemoteRevision(1, 'dev-B')
    expect(host.api.project).not.toHaveBeenCalled()
  })

  it('rebases pending local edits onto the remote change', async () => {
    start()
    rename('local')
    host.remoteEdit((d) => {
      d.tracks[1]!.name = 'remote'
    })
    await sync.onRemoteRevision(2, 'dev-B')
    expect(notices).toEqual(['merged'])
    expect(s().project?.name).toBe('local')
    await vi.runAllTimersAsync()
    expect(host.project).toMatchObject({ name: 'local', revision: 3 })
    expect(host.project.tracks[1]?.name).toBe('remote')
  })

  it('defers remote changes during a gesture until it ends', async () => {
    start()
    s().beginTransaction('Drag')
    host.remoteEdit((d) => {
      d.name = 'remote'
    })
    await sync.onRemoteRevision(2, 'dev-B')
    expect(host.api.project).not.toHaveBeenCalled()
    s().commitTransaction()
    await vi.runAllTimersAsync()
    expect(s().project?.name).toBe('remote')
  })

  it('defers remote changes while a save is in flight', async () => {
    start()
    const release = host.hold()
    rename('local')
    await vi.advanceTimersByTimeAsync(500)
    await sync.onRemoteRevision(99, 'dev-B')
    expect(host.api.project).not.toHaveBeenCalled()
    release()
    await vi.runAllTimersAsync()
    // The save succeeded at revision 2; the queued event then fetched (nothing newer).
    expect(host.api.project).toHaveBeenCalledTimes(1)
    expect(s().sync.revision).toBe(2)
  })

  it('survives a failed fetch', async () => {
    start()
    host.api.project.mockRejectedValueOnce(new ApiError(0, 'down'))
    await expect(sync.onRemoteRevision(2, 'dev-B')).resolves.toBeUndefined()
    expect(s().project?.revision).toBe(1)
  })
})

describe('offline tolerance', () => {
  it('keeps edits, persists a draft and retries with backoff', async () => {
    start()
    online = false
    host.failNext.push(new ApiError(0, 'Network error'))
    rename('offline edit')
    await vi.advanceTimersByTimeAsync(500)
    expect(s().sync).toMatchObject({ status: 'offline', error: 'Network error' })
    expect(sync.pending).toBe(true)
    expect(drafts.map.get('p1')).toMatchObject({ baseRevision: 1 })
    expect(drafts.map.get('p1')?.patches.length).toBeGreaterThan(0)
    // First retry after exactly retryBaseMs (attempt 0 has no jitter range).
    online = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.saves).toHaveLength(2)
    expect(s().sync.status).toBe('saved')
    expect(drafts.map.has('p1')).toBe(false)
  })

  it('retries immediately when the browser comes back online', async () => {
    start({ retryBaseMs: 60_000, retryMaxMs: 60_000 })
    online = false
    host.failNext.push(new ApiError(503, 'unavailable'))
    rename('x')
    await vi.advanceTimersByTimeAsync(500)
    expect(s().sync.status).toBe('offline')
    online = true
    win.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.saves).toHaveLength(2)
    expect(s().sync.status).toBe('saved')
  })

  it('does not retry non-retryable errors', async () => {
    start()
    host.failNext.push(new ApiError(400, 'bad project'))
    rename('x')
    await vi.runAllTimersAsync()
    expect(s().sync).toMatchObject({ status: 'error', error: 'bad project' })
    expect(host.saves).toHaveLength(1)
    expect(sync.pending).toBe(true)
  })

  it('recovers a draft left by a previous session', async () => {
    const patches = [{ op: 'replace' as const, path: ['name'], value: 'recovered' }]
    drafts.map.set('p1', { baseRevision: 1, patches, savedAt: 1 })
    start()
    await expect(sync.recoverDraft()).resolves.toBe(true)
    expect(notices).toEqual(['draft-restored'])
    expect(s().project?.name).toBe('recovered')
    await vi.runAllTimersAsync()
    expect(host.project.name).toBe('recovered')
  })

  it('recoverDraft is a no-op without a draft', async () => {
    start()
    await expect(sync.recoverDraft()).resolves.toBe(false)
    expect(notices).toEqual([])
  })

  it('dispose persists unsaved edits and stops saving', async () => {
    start()
    rename('unsent')
    sync.dispose()
    await vi.runAllTimersAsync()
    expect(host.saves).toHaveLength(0)
    expect(drafts.map.get('p1')?.patches[0]).toMatchObject({ path: ['name'], value: 'unsent' })
  })
})

describe('flush', () => {
  it('saves immediately and resolves when the host has everything', async () => {
    start()
    rename('now')
    const p = sync.flush()
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(host.project.name).toBe('now')
    expect(sync.pending).toBe(false)
  })

  it('rejects when the save fails', async () => {
    start()
    host.failNext.push(new ApiError(400, 'bad'))
    rename('x')
    await expect(sync.flush()).rejects.toThrow('bad')
  })

  it('resolves immediately with nothing pending', async () => {
    start()
    await expect(sync.flush()).resolves.toBeUndefined()
    expect(host.saves).toHaveLength(0)
  })
})

it('requires a loaded project', () => {
  s().unload()
  expect(() => start()).toThrow(/no project loaded/)
})
