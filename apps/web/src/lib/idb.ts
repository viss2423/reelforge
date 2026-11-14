/**
 * Minimal promise wrapper over IndexedDB, shared by the app and the service worker.
 * One database, a few key/value object stores. Values must be structured-cloneable
 * (Files and Blobs are, so shared media can be parked here without reading it).
 */
export type IdbStore = 'uploads' | 'shared' | 'drafts'

const DB_NAME = 'reelforge'
const DB_VERSION = 1
const STORES: readonly IdbStore[] = ['uploads', 'shared', 'drafts']

let dbPromise: Promise<IDBDatabase> | undefined

const open = (): Promise<IDBDatabase> => {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      for (const s of STORES)
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
    }
    req.onsuccess = () => {
      const db = req.result
      // Another tab upgrading the schema: close so it isn't blocked; reopen lazily.
      db.onversionchange = () => {
        db.close()
        dbPromise = undefined
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  }).catch((err: unknown) => {
    dbPromise = undefined
    throw err
  })
  return dbPromise
}

const run = async <T>(
  store: IdbStore,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export const idbGet = <T>(store: IdbStore, key: string): Promise<T | undefined> =>
  run(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)

export const idbSet = async (store: IdbStore, key: string, value: unknown): Promise<void> => {
  await run(store, 'readwrite', (s) => s.put(value, key))
}

export const idbDelete = async (store: IdbStore, key: string): Promise<void> => {
  await run(store, 'readwrite', (s) => s.delete(key))
}

export const idbKeys = async (store: IdbStore): Promise<string[]> =>
  (await run(store, 'readonly', (s) => s.getAllKeys())).map(String)

/** Test hook: forget the cached connection (e.g. after replacing the global indexedDB). */
export const resetIdbForTests = (): void => {
  dbPromise = undefined
}
