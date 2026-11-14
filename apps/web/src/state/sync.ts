/**
 * Autosave + multi-device live sync for the open project.
 *
 * Model: `base` is the last project snapshot the server acknowledged (with its revision);
 * `unsaved` are the Immer patches of local edits made since. Saving PUTs the whole project
 * with `expectedRevision = base.revision`.
 *
 * - Debounced (500 ms) after each committed change; never mid-gesture (open transaction).
 * - 409 (someone else saved first) → rebase: re-apply our unsaved patches onto the server's
 *   project; if they no longer apply or the result is invalid, adopt the server version.
 * - WS `project` event from another device → fetch and rebase the same way.
 * - Offline / server down → keep patches, persist them to IndexedDB (survives reloads),
 *   retry with backoff and immediately when the browser comes back online.
 */
import { Project } from '@reelforge/core'
import { applyPatches, freeze, produce, type Patch } from 'immer'
import { ApiError, RevisionConflict, type ApiClient } from '@/api/client.ts'
import { backoffDelay } from '@/lib/backoff.ts'
import { idbDelete, idbGet, idbSet } from '@/lib/idb.ts'
import type { EditorStoreApi, SyncInfo } from './editorStore.ts'

export interface DraftRecord {
  baseRevision: number
  patches: Patch[]
  savedAt: number
}

export interface DraftStore {
  get(projectId: string): Promise<DraftRecord | undefined>
  set(projectId: string, rec: DraftRecord): Promise<void>
  delete(projectId: string): Promise<void>
}

export const idbDraftStore: DraftStore = {
  get: (id) => idbGet<DraftRecord>('drafts', id).catch(() => undefined),
  set: (id, rec) => idbSet('drafts', id, rec).catch(() => undefined),
  delete: (id) => idbDelete('drafts', id).catch(() => undefined),
}

/** What happened when remote changes met local ones (for user-facing notices). */
export type SyncNotice =
  | 'remote-applied' // another device's changes were loaded (no local edits pending)
  | 'merged' // local unsaved edits were re-applied on top of another device's changes
  | 'local-discarded' // local unsaved edits conflicted and were dropped
  | 'draft-restored' // offline edits from a previous session were recovered

export interface ProjectSyncOptions {
  store: EditorStoreApi
  api: Pick<ApiClient, 'saveProject' | 'project'>
  deviceId: string
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  drafts?: DraftStore
  isOnline?: () => boolean
  onNotice?: (notice: SyncNotice) => void
  /** Validates a rebased project before adopting it. Default: core zod schema. */
  validate?: (p: Project) => boolean
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | undefined
}

export interface ProjectSync {
  /** Saves now and resolves once the server has every local change; rejects if it can't. */
  flush(): Promise<void>
  /** Handles a WebSocket `project` event. */
  onRemoteRevision(revision: number, origin: string): Promise<void>
  /** Re-applies edits persisted by a previous offline session. Resolves true if any. */
  recoverDraft(): Promise<boolean>
  /** True while there are local changes the server doesn't have yet. */
  readonly pending: boolean
  dispose(): void
}

const defaultValidate = (p: Project): boolean => Project.safeParse(p).success

/** Starts syncing the project currently loaded in `store`. */
export const createProjectSync = (opts: ProjectSyncOptions): ProjectSync => {
  const {
    store,
    api,
    deviceId,
    debounceMs = 500,
    retryBaseMs = 1000,
    retryMaxMs = 30_000,
    drafts = idbDraftStore,
    isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
    onNotice,
    validate = defaultValidate,
    win = typeof window === 'undefined' ? undefined : window,
    doc = typeof document === 'undefined' ? undefined : document,
  } = opts

  const initial = store.getState().project
  if (!initial) throw new Error('createProjectSync: no project loaded')
  const projectId = initial.id

  let base: Project = initial
  let unsaved: Patch[] = []
  let inflight: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let queuedRemote = 0
  let disposed = false

  const setSync = (patch: Partial<SyncInfo>) => store.getState().setSync(patch)

  const schedule = (delay = debounceMs) => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => void save(), delay)
  }

  const persistDraft = () => {
    if (unsaved.length === 0) return
    void drafts.set(projectId, {
      baseRevision: base.revision,
      patches: unsaved,
      savedAt: Date.now(),
    })
  }

  /** Replace local state with `server` + our unsaved patches (if they still apply). */
  const rebaseOnto = (server: Project): SyncNotice => {
    const local = unsaved
    let next = server
    let discarded = false
    if (local.length) {
      try {
        const candidate = applyPatches(server, local)
        if (validate(candidate)) next = candidate
        else discarded = true
      } catch {
        discarded = true
      }
    }
    base = freeze(server, true)
    unsaved = discarded ? [] : local
    store.getState().replaceProject(next)
    setSync({
      revision: server.revision,
      status: unsaved.length ? 'pending' : 'saved',
      error: null,
    })
    if (discarded) void drafts.delete(projectId)
    if (unsaved.length) schedule(0)
    return discarded ? 'local-discarded' : local.length ? 'merged' : 'remote-applied'
  }

  const save = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (inflight) return inflight
    // Mid-gesture: the transaction commit reschedules us.
    if (store.getState().transaction !== null) return Promise.resolve()
    const project = store.getState().project
    // Another project may have been opened while this session was closing.
    if (!project || project.id !== projectId || unsaved.length === 0) return Promise.resolve()
    clearTimeout(timer)
    clearTimeout(retryTimer)
    const sending = unsaved
    unsaved = []
    setSync({ status: 'saving' })
    inflight = (async () => {
      try {
        const revision = await api.saveProject(project, base.revision, deviceId)
        base = produce(project, (d) => {
          d.revision = revision
        })
        retryAttempt = 0
        store.getState().setRevision(revision)
        if (unsaved.length) {
          setSync({ status: 'pending', error: null })
          schedule()
        } else {
          setSync({ status: 'saved', lastSavedAt: Date.now(), error: null })
          void drafts.delete(projectId)
        }
      } catch (err) {
        unsaved = [...sending, ...unsaved]
        if (err instanceof RevisionConflict) {
          onNotice?.(rebaseOnto(err.project))
        } else {
          persistDraft()
          const message = err instanceof Error ? err.message : String(err)
          const transient = !(err instanceof ApiError) || err.retryable
          setSync({ status: transient && !isOnline() ? 'offline' : 'error', error: message })
          if (transient) {
            clearTimeout(retryTimer)
            retryTimer = setTimeout(
              () => void save(),
              backoffDelay(retryAttempt++, { base: retryBaseMs, max: retryMaxMs }),
            )
          }
        }
      } finally {
        inflight = null
      }
      if (queuedRemote > base.revision) {
        const rev = queuedRemote
        queuedRemote = 0
        await onRemoteRevision(rev, '')
      }
    })()
    return inflight
  }

  const onRemoteRevision = async (revision: number, origin: string): Promise<void> => {
    if (disposed || origin === deviceId || revision <= base.revision) return
    if (inflight || store.getState().transaction !== null) {
      queuedRemote = Math.max(queuedRemote, revision)
      return
    }
    let server: Project
    try {
      server = await api.project(projectId)
    } catch {
      return // The next save will hit a 409 and rebase then.
    }
    if (disposed || server.revision <= base.revision) return
    if (store.getState().project?.id !== projectId) return
    if (inflight || store.getState().transaction !== null) {
      queuedRemote = Math.max(queuedRemote, server.revision)
      return
    }
    onNotice?.(rebaseOnto(server))
  }

  const unsubChanges = store.getState().subscribeChanges((change) => {
    if (store.getState().project?.id !== projectId) return
    // Revision bumps are bookkeeping, never user edits.
    for (const p of change.patches) if (p.path[0] !== 'revision') unsaved.push(p)
    if (unsaved.length === 0) return
    setSync({ status: 'pending' })
    schedule()
  })

  const unsubStore = store.subscribe((s, prev) => {
    if (prev.transaction !== null && s.transaction === null) {
      if (unsaved.length) schedule()
      if (queuedRemote > base.revision) {
        const rev = queuedRemote
        queuedRemote = 0
        void onRemoteRevision(rev, '')
      }
    }
  })

  const onOnline = () => {
    if (unsaved.length) {
      retryAttempt = 0
      schedule(0)
    }
  }
  const onHide = () => {
    if (doc?.visibilityState === 'hidden' && unsaved.length) {
      persistDraft()
      void save()
    }
  }
  win?.addEventListener('online', onOnline)
  doc?.addEventListener('visibilitychange', onHide)

  return {
    get pending() {
      return unsaved.length > 0 || inflight !== null
    },

    async flush() {
      // Bounded: each pass either saves, rebases (then saves again) or fails.
      clearTimeout(timer)
      for (let i = 0; i < 5 && (unsaved.length > 0 || inflight); i++) {
        if (store.getState().transaction !== null) break
        await (inflight ?? save())
        const { status, error } = store.getState().sync
        if (status === 'error' || status === 'offline') {
          throw new Error(error ?? 'Could not save the project')
        }
      }
      if (unsaved.length > 0 || inflight) throw new Error('Could not save the project')
    },

    onRemoteRevision,

    async recoverDraft() {
      const draft = await drafts.get(projectId)
      if (!draft || draft.patches.length === 0 || disposed) return false
      unsaved = [...draft.patches, ...unsaved]
      const notice = rebaseOnto(base)
      if (notice === 'local-discarded') {
        onNotice?.(notice)
        return false
      }
      onNotice?.('draft-restored')
      return true
    },

    dispose() {
      if (unsaved.length) persistDraft()
      disposed = true
      clearTimeout(timer)
      clearTimeout(retryTimer)
      unsubChanges()
      unsubStore()
      win?.removeEventListener('online', onOnline)
      doc?.removeEventListener('visibilitychange', onHide)
    },
  }
}
