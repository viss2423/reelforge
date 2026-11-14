/**
 * Upload a file picked or recorded in a panel and resolve once the host has probed it
 * (duration known), so the caller can place it precisely (e.g. a voiceover at the playhead
 * where recording started) instead of the media library's "append at the end".
 */
import type { Asset } from '@reelforge/core'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { enqueueUploads, whenSettled } from '@/state/uploads.ts'
import { isAssetPlaceable } from '../actions.ts'

/** Resolves when `assetId` is placeable in the editor store (probe finished). */
export const whenPlaceable = (
  assetId: string,
  store: EditorStoreApi = editorStore,
  timeoutMs = 180_000,
): Promise<Asset> =>
  new Promise((resolve, reject) => {
    const check = (): boolean => {
      const a = store.getState().assets[assetId]
      if (a && isAssetPlaceable(a)) {
        done()
        resolve(a)
        return true
      }
      if (a?.proxy === 'failed') {
        done()
        reject(new Error(`${a.name} could not be read by the host`))
        return true
      }
      return false
    }
    const unsub = store.subscribe((s, prev) => {
      if (s.assets !== prev.assets) check()
    })
    const timer = setTimeout(() => {
      done()
      reject(new Error('The host is taking too long to process this file'))
    }, timeoutMs)
    const done = () => {
      unsub()
      clearTimeout(timer)
    }
    check()
  })

/** Uploads one file into the open project and waits until it can be placed. */
export const uploadAndWait = async (
  file: File,
  store: EditorStoreApi = editorStore,
): Promise<Asset> => {
  const projectId = store.getState().project?.id
  const [taskId] = enqueueUploads([file], projectId ? { projectId } : {})
  const [task] = await whenSettled(taskId ? [taskId] : [])
  if (!task?.asset) throw new Error(task?.error ?? `Upload of ${file.name} did not finish`)
  // The asset reaches the store through the uploaded hook / WS; seed it in case neither ran.
  if (!store.getState().assets[task.asset.id]) store.getState().upsertAsset(task.asset)
  return whenPlaceable(task.asset.id, store)
}
