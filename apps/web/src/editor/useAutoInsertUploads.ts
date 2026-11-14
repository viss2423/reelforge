/**
 * Places media imported "into this project" on the timeline as uploads complete.
 *
 * Order is preserved per pick batch: a file is placed only once every earlier file of the
 * same batch is placed or failed. A file waits until the host has probed it (duration
 * known) — the `asset` WebSocket event updates the store, which re-runs the check.
 */
import type { Asset } from '@reelforge/core'
import { useEffect } from 'react'
import { toast } from '@/components/Toast.tsx'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { markInserted, uploadsStore, type UploadTask } from '@/state/uploads.ts'
import { addAssetToTimeline, isAssetPlaceable } from './actions.ts'

type Settled = 'error' | 'cancelled'
const settledWithoutAsset = (t: UploadTask): t is UploadTask & { status: Settled } =>
  t.status === 'error' || t.status === 'cancelled'

/**
 * Decides which tasks can be inserted now, in order. Pure (exported for tests): returns the
 * tasks to insert with the freshest asset metadata, and tasks to give up on.
 */
export const planInsertions = (
  tasks: readonly UploadTask[],
  projectId: string,
  assets: Readonly<Record<string, Asset>>,
): { insert: Array<{ task: UploadTask; asset: Asset }>; skip: UploadTask[] } => {
  const insert: Array<{ task: UploadTask; asset: Asset }> = []
  const skip: UploadTask[] = []
  const batches = new Map<string, UploadTask[]>()
  for (const t of tasks) {
    if (t.projectId !== projectId || !t.addToTimeline) continue
    const list = batches.get(t.batchId)
    if (list) list.push(t)
    else batches.set(t.batchId, [t])
  }
  for (const list of batches.values()) {
    list.sort((a, b) => a.order - b.order)
    for (const t of list) {
      if (t.inserted || settledWithoutAsset(t)) continue
      if (t.status !== 'done' || !t.asset) break // keep pick order: wait for this one
      const asset = assets[t.asset.id] ?? t.asset
      if (asset.proxy === 'failed' && !isAssetPlaceable(asset)) {
        skip.push(t)
        continue
      }
      if (!isAssetPlaceable(asset)) break
      insert.push({ task: t, asset })
    }
  }
  return { insert, skip }
}

const flushOnce = (store: EditorStoreApi, projectId: string): void => {
  const { project, assets } = store.getState()
  if (project?.id !== projectId) return
  const { insert, skip } = planInsertions(uploadsStore.getState().tasks, projectId, assets)
  for (const t of skip) {
    markInserted(t.id)
    toast.error(`Couldn't read ${t.name}`, 'The file may be corrupt or in an unsupported format.')
  }
  for (const { task, asset } of insert) {
    // Mark first: a failing insert must not be retried on every store update.
    markInserted(task.id)
    const r = addAssetToTimeline(store, asset, { position: 'end' })
    if (!r.ok) toast.error(`Couldn't add ${task.name}`, r.reason)
  }
}

let flushing = false
let again = false

/**
 * Inserting marks tasks, which notifies the uploads store, which calls back into flush:
 * re-entrant calls are folded into another pass instead of running nested.
 */
const flush = (store: EditorStoreApi, projectId: string): void => {
  if (flushing) {
    again = true
    return
  }
  flushing = true
  try {
    do {
      again = false
      flushOnce(store, projectId)
    } while (again)
  } finally {
    flushing = false
  }
}

/** Runs while the editor for `projectId` is open. */
export const useAutoInsertUploads = (
  projectId: string,
  store: EditorStoreApi = editorStore,
): void => {
  useEffect(() => {
    flush(store, projectId)
    const offUploads = uploadsStore.subscribe(() => flush(store, projectId))
    const offAssets = store.subscribe((s, prev) => {
      if (s.assets !== prev.assets || s.project?.id !== prev.project?.id) flush(store, projectId)
    })
    return () => {
      offUploads()
      offAssets()
    }
  }, [projectId, store])
}
