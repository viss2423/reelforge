/**
 * Global upload queue. Lives outside any screen so uploads keep going while the user
 * navigates (Home → Editor). Files upload two at a time (each with 3 parallel chunks),
 * in the order they were picked so the first clip is usable first.
 *
 * Tasks flagged `addToTimeline` are picked up by the editor of `projectId`, which inserts
 * them in pick order once they finish (see editor/useAutoInsertUploads.ts).
 */
import type { Asset } from '@reelforge/core'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { api } from '@/api/index.ts'
import { Uploader } from '@/api/uploader.ts'
import { isAbortError } from '@/lib/backoff.ts'

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled'

export interface UploadTask {
  id: string
  /** Files picked together share a batch (keeps their order). */
  batchId: string
  order: number
  name: string
  size: number
  mime: string
  loaded: number
  status: UploadStatus
  error?: string
  asset?: Asset
  projectId?: string
  addToTimeline: boolean
  /** Set by the editor once the asset was placed on the timeline. */
  inserted: boolean
}

interface UploadsState {
  tasks: UploadTask[]
}

export const MAX_CONCURRENT_FILES = 2

const files = new Map<string, File>()
const controllers = new Map<string, AbortController>()
const uploadedListeners = new Set<(asset: Asset, task: UploadTask) => void>()
let uploader: Uploader | undefined
let running = 0

export const uploadsStore = createStore<UploadsState>()(() => ({ tasks: [] }))

const patch = (id: string, p: Partial<UploadTask>) =>
  uploadsStore.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p } : t)) }))

const pump = () => {
  while (running < MAX_CONCURRENT_FILES) {
    const next = uploadsStore.getState().tasks.find((t) => t.status === 'queued')
    if (!next) return
    running++
    patch(next.id, { status: 'uploading', loaded: 0 })
    void run(next.id).finally(() => {
      running--
      pump()
    })
  }
}

const run = async (id: string): Promise<void> => {
  const file = files.get(id)
  if (!file) return
  const ctrl = new AbortController()
  controllers.set(id, ctrl)
  uploader ??= new Uploader({ api })
  // Progress events can arrive hundreds of times per second; coalesce to one store
  // update per animation frame so the library grid doesn't re-render needlessly.
  let pendingLoaded = -1
  let raf = 0
  const flush = () => {
    raf = 0
    if (pendingLoaded >= 0) patch(id, { loaded: pendingLoaded })
  }
  try {
    const asset = await uploader.upload(file, {
      signal: ctrl.signal,
      onProgress: ({ loaded }) => {
        pendingLoaded = loaded
        if (!raf) raf = requestAnimationFrame(flush)
      },
    })
    cancelAnimationFrame(raf)
    patch(id, { status: 'done', loaded: file.size, asset })
    files.delete(id)
    const task = uploadsStore.getState().tasks.find((t) => t.id === id)
    if (task) for (const l of uploadedListeners) l(asset, task)
  } catch (err) {
    cancelAnimationFrame(raf)
    if (isAbortError(err)) patch(id, { status: 'cancelled' })
    else patch(id, { status: 'error', error: err instanceof Error ? err.message : String(err) })
  } finally {
    controllers.delete(id)
  }
}

/** Queues files for upload. Returns task ids in the same order. */
export const enqueueUploads = (
  list: Iterable<File>,
  opts: { projectId?: string; addToTimeline?: boolean } = {},
): string[] => {
  const batchId = crypto.randomUUID()
  const tasks: UploadTask[] = []
  let order = 0
  for (const file of list) {
    const id = crypto.randomUUID()
    files.set(id, file)
    tasks.push({
      id,
      batchId,
      order: order++,
      name: file.name,
      size: file.size,
      mime: file.type,
      loaded: 0,
      status: 'queued',
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      addToTimeline: opts.addToTimeline ?? false,
      inserted: false,
    })
  }
  uploadsStore.setState((s) => ({ tasks: [...s.tasks, ...tasks] }))
  pump()
  return tasks.map((t) => t.id)
}

export const cancelUpload = (id: string): void => {
  const ctrl = controllers.get(id)
  if (ctrl) ctrl.abort(new DOMException('Upload cancelled', 'AbortError'))
  else patch(id, { status: 'cancelled' })
}

export const retryUpload = (id: string): void => {
  if (!files.has(id)) return
  patch(id, { status: 'queued', error: undefined })
  pump()
}

/** Removes finished/cancelled/failed tasks from the list. */
export const dismissUpload = (id: string): void => {
  files.delete(id)
  uploadsStore.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
}

export const markInserted = (id: string): void => patch(id, { inserted: true })

/** Called for every completed upload (e.g. to update the assets query cache). */
export const onAssetUploaded = (cb: (asset: Asset, task: UploadTask) => void): (() => void) => {
  uploadedListeners.add(cb)
  return () => uploadedListeners.delete(cb)
}

/** Resolves when all given tasks are done/failed/cancelled. */
export const whenSettled = (ids: readonly string[]): Promise<UploadTask[]> =>
  new Promise((resolve) => {
    const check = () => {
      const tasks = ids
        .map((id) => uploadsStore.getState().tasks.find((t) => t.id === id))
        .filter((t): t is UploadTask => !!t)
      if (
        tasks.every((t) => t.status === 'done' || t.status === 'error' || t.status === 'cancelled')
      ) {
        unsub()
        resolve(tasks)
        return true
      }
      return false
    }
    const unsub = uploadsStore.subscribe(check)
    check()
  })

export const useUploads = <T>(selector: (s: UploadsState) => T): T =>
  useStore(uploadsStore, selector)

/** Test hook: clears all tasks and swaps the uploader. */
export const resetUploadsForTests = (u?: Uploader): void => {
  for (const c of controllers.values()) c.abort()
  files.clear()
  controllers.clear()
  uploadedListeners.clear()
  running = 0
  uploader = u
  uploadsStore.setState({ tasks: [] })
}
