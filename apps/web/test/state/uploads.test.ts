import type { Asset } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Uploader, UploadFileOptions } from '@/api/uploader.ts'
import {
  MAX_CONCURRENT_FILES,
  cancelUpload,
  dismissUpload,
  enqueueUploads,
  onAssetUploaded,
  resetUploadsForTests,
  retryUpload,
  uploadsStore,
  whenSettled,
  type UploadTask,
} from '@/state/uploads.ts'
import { makeAsset } from '../fixtures.ts'

/** Uploader double whose uploads finish when the test says so. */
class ManualUploader {
  calls: Array<{
    file: File
    opts: UploadFileOptions
    resolve: (a: Asset) => void
    reject: (e: unknown) => void
  }> = []
  upload(file: File, opts: UploadFileOptions = {}): Promise<Asset> {
    return new Promise((resolve, reject) => {
      this.calls.push({ file, opts, resolve, reject })
      opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason))
    })
  }
}

const file = (name: string, size = 100) =>
  new File([new Uint8Array(size)], name, { type: 'video/mp4' })
const tasks = () => uploadsStore.getState().tasks
const tick = () => new Promise((r) => setTimeout(r, 0))

let up: ManualUploader

beforeEach(() => {
  up = new ManualUploader()
  resetUploadsForTests(up as unknown as Uploader)
})
afterEach(() => resetUploadsForTests())

describe('upload queue', () => {
  it('queues files in pick order and uploads two at a time', async () => {
    const ids = enqueueUploads([file('a'), file('b'), file('c')], {
      projectId: 'p1',
      addToTimeline: true,
    })
    expect(tasks().map((t) => [t.name, t.order, t.status])).toEqual([
      ['a', 0, 'uploading'],
      ['b', 1, 'uploading'],
      ['c', 2, 'queued'],
    ])
    expect(new Set(tasks().map((t) => t.batchId)).size).toBe(1)
    expect(tasks()[0]).toMatchObject({ projectId: 'p1', addToTimeline: true, inserted: false })
    expect(up.calls).toHaveLength(MAX_CONCURRENT_FILES)
    up.calls[0]?.resolve(makeAsset({ id: 'A' }))
    await tick()
    expect(tasks().find((t) => t.id === ids[0])).toMatchObject({ status: 'done', loaded: 100 })
    expect(tasks().find((t) => t.id === ids[0])?.asset?.id).toBe('A')
    expect(up.calls).toHaveLength(3)
    expect(tasks()[2]?.status).toBe('uploading')
  })

  it('coalesces progress into animation frames', async () => {
    const [id] = enqueueUploads([file('a', 1000)])
    up.calls[0]?.opts.onProgress?.({ loaded: 100, total: 1000 })
    up.calls[0]?.opts.onProgress?.({ loaded: 400, total: 1000 })
    expect(tasks()[0]?.loaded).toBe(0)
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    expect(tasks().find((t) => t.id === id)?.loaded).toBe(400)
  })

  it('notifies onAssetUploaded listeners', async () => {
    const cb = vi.fn<(asset: Asset, task: UploadTask) => void>()
    onAssetUploaded(cb)
    enqueueUploads([file('a')])
    up.calls[0]?.resolve(makeAsset({ id: 'A' }))
    await tick()
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'A' }),
      expect.objectContaining({ name: 'a' }),
    )
  })

  it('records failures and retries them', async () => {
    const [id] = enqueueUploads([file('a')])
    up.calls[0]?.reject(new Error('disk full'))
    await tick()
    expect(tasks()[0]).toMatchObject({ status: 'error', error: 'disk full' })
    retryUpload(id!)
    expect(tasks()[0]?.status).toBe('uploading')
    expect(up.calls).toHaveLength(2)
  })

  it('cancels running and queued uploads', async () => {
    const [a, b, c] = enqueueUploads([file('a'), file('b'), file('c')])
    cancelUpload(a!)
    cancelUpload(c!)
    await tick()
    const byId = (id: string) => tasks().find((t) => t.id === id)?.status
    expect(byId(a!)).toBe('cancelled')
    expect(byId(c!)).toBe('cancelled')
    expect(byId(b!)).toBe('uploading')
    // The cancelled queued task never starts.
    expect(up.calls.map((x) => x.file.name)).toEqual(['a', 'b'])
  })

  it('dismiss removes a task', () => {
    const [id] = enqueueUploads([file('a')])
    dismissUpload(id!)
    expect(tasks()).toEqual([])
  })

  it('whenSettled resolves once every task finished', async () => {
    const ids = enqueueUploads([file('a'), file('b')])
    const settled = whenSettled(ids)
    up.calls[0]?.resolve(makeAsset())
    up.calls[1]?.reject(new Error('x'))
    const result = await settled
    expect(result.map((t) => t.status)).toEqual(['done', 'error'])
  })
})
