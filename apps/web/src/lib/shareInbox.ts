/**
 * Web Share Target inbox. The service worker receives the shared POST, parks the files in
 * IndexedDB under a fresh id and redirects to `/share-target?id=…`; the page then takes them.
 */
import { idbDelete, idbGet, idbSet } from './idb.ts'

export interface SharedBatch {
  files: File[]
  title?: string
  text?: string
  createdAt: number
}

export const putSharedBatch = async (batch: Omit<SharedBatch, 'createdAt'>): Promise<string> => {
  const id = crypto.randomUUID()
  await idbSet('shared', id, { ...batch, createdAt: Date.now() } satisfies SharedBatch)
  return id
}

/** Returns the batch without removing it (so a reload of the page still finds it). */
export const peekSharedBatch = (id: string): Promise<SharedBatch | undefined> =>
  idbGet<SharedBatch>('shared', id)

export const discardSharedBatch = (id: string): Promise<void> => idbDelete('shared', id)
