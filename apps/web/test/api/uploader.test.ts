import type { Asset } from '@reelforge/core'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client.ts'
import {
  Uploader,
  fileFingerprint,
  type ChunkRequest,
  type ResumeRecord,
  type ResumeStore,
} from '@/api/uploader.ts'
import { makeAsset } from '../fixtures.ts'

const CHUNK = 10

class MemoryResume implements ResumeStore {
  map = new Map<string, ResumeRecord>()
  get = vi.fn<ResumeStore['get']>(async (fp) => this.map.get(fp))
  set = vi.fn<ResumeStore['set']>(async (fp, r) => void this.map.set(fp, r))
  delete = vi.fn<ResumeStore['delete']>(async (fp) => void this.map.delete(fp))
}

const makeApi = () => {
  let n = 0
  const api = {
    authHeaders: () => ({ authorization: 'Bearer t' }),
    chunkUrl: (id: string, i: number) => `/api/uploads/${id}/chunks/${i}`,
    initUpload: vi.fn<() => Promise<{ uploadId: string; chunkSize: number }>>(async () => ({
      uploadId: `u${++n}`,
      chunkSize: CHUNK,
    })),
    uploadStatus: vi.fn<(id: string) => Promise<{ received: number[] }>>(async () => ({
      received: [],
    })),
    completeUpload: vi.fn<(id: string) => Promise<Asset>>(async (id) =>
      makeAsset({ id: `asset-${id}` }),
    ),
  }
  return api
}

const makeFile = (size: number, name = 'video.mp4') => {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return new File([bytes], name, { type: 'video/mp4', lastModified: 1234 })
}

const chunkIndex = (req: ChunkRequest) => Number(req.url.split('/').at(-1))

const setup = (
  sendChunk: (req: ChunkRequest) => Promise<void> = async (req) => req.onProgress(req.blob.size),
  opts: { parallel?: number; maxRetries?: number } = {},
) => {
  const api = makeApi()
  const resume = new MemoryResume()
  const send = vi.fn<(req: ChunkRequest) => Promise<void>>(sendChunk)
  const uploader = new Uploader({
    api: api as unknown as ApiClient,
    sendChunk: send,
    resume,
    retryBaseMs: 1,
    ...opts,
  })
  return { api, resume, send, uploader }
}

describe('Uploader', () => {
  it('slices the file into server-sized chunks and completes', async () => {
    const { api, send, uploader, resume } = setup()
    const file = makeFile(25)
    const progress: number[] = []
    const asset = await uploader.upload(file, { onProgress: (p) => progress.push(p.loaded) })
    expect(asset.id).toBe('asset-u1')
    expect(api.initUpload).toHaveBeenCalledWith({ name: 'video.mp4', size: 25, mime: 'video/mp4' })
    const sent = send.mock.calls.map(([r]) => [chunkIndex(r), r.blob.size])
    expect(sent.toSorted((a, b) => a[0]! - b[0]!)).toEqual([
      [0, 10],
      [1, 10],
      [2, 5],
    ])
    // Chunk bytes are the right slice of the file.
    const last = send.mock.calls.find(([r]) => chunkIndex(r) === 2)![0]
    expect([...new Uint8Array(await last.blob.arrayBuffer())]).toEqual([20, 21, 22, 23, 24])
    expect(send.mock.calls[0]?.[0].headers).toEqual({ authorization: 'Bearer t' })
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(25)
    expect(progress).toEqual(progress.toSorted((a, b) => a - b))
    expect(api.completeUpload).toHaveBeenCalledWith('u1', undefined)
    expect(resume.map.size).toBe(0)
  })

  it('never reads the whole file into memory', async () => {
    const { uploader } = setup()
    const file = makeFile(40)
    const whole = [vi.spyOn(file, 'arrayBuffer'), vi.spyOn(file, 'text'), vi.spyOn(file, 'stream')]
    await uploader.upload(file)
    for (const spy of whole) expect(spy).not.toHaveBeenCalled()
  })

  it('runs at most `parallel` chunk requests at once', async () => {
    let active = 0
    let peak = 0
    const { uploader, send } = setup(async (req) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      req.onProgress(req.blob.size)
      active--
    })
    await uploader.upload(makeFile(CHUNK * 10))
    expect(send).toHaveBeenCalledTimes(10)
    expect(peak).toBe(3)
  })

  it('retries failed chunks with backoff and resets their progress', async () => {
    const failures = new Map([[1, 2]])
    const progress: number[] = []
    const { uploader, send } = setup(async (req) => {
      const i = chunkIndex(req)
      const left = failures.get(i) ?? 0
      req.onProgress(req.blob.size / 2)
      if (left > 0) {
        failures.set(i, left - 1)
        throw new ApiError(i === 1 ? 0 : 503, 'flaky')
      }
      req.onProgress(req.blob.size)
    })
    await uploader.upload(makeFile(30), { onProgress: (p) => progress.push(p.loaded) })
    expect(send.mock.calls.filter(([r]) => chunkIndex(r) === 1)).toHaveLength(3)
    expect(progress.at(-1)).toBe(30)
  })

  it('gives up on non-retryable errors and aborts sibling chunks', async () => {
    const aborted: number[] = []
    const { uploader, api } = setup(async (req) => {
      const i = chunkIndex(req)
      if (i === 0) throw new ApiError(413, 'too large')
      await new Promise<void>((resolve, reject) => {
        req.signal.addEventListener('abort', () => {
          aborted.push(i)
          reject(new DOMException('Aborted', 'AbortError'))
        })
        setTimeout(resolve, 1000)
      })
    })
    await expect(uploader.upload(makeFile(30))).rejects.toMatchObject({ status: 413 })
    expect(aborted.toSorted((a, b) => a - b)).toEqual([1, 2])
    expect(api.completeUpload).not.toHaveBeenCalled()
  })

  it('gives up after maxRetries', async () => {
    const { uploader, send } = setup(
      async () => {
        throw new ApiError(500, 'down')
      },
      { maxRetries: 2, parallel: 1 },
    )
    await expect(uploader.upload(makeFile(5))).rejects.toMatchObject({ status: 500 })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('resumes a known upload, sending only missing chunks', async () => {
    const { uploader, api, resume, send } = setup()
    const file = makeFile(30)
    resume.map.set(fileFingerprint(file), { uploadId: 'old', chunkSize: CHUNK, createdAt: 0 })
    api.uploadStatus.mockResolvedValueOnce({ received: [0, 2] })
    const progress: number[] = []
    const asset = await uploader.upload(file, { onProgress: (p) => progress.push(p.loaded) })
    expect(api.initUpload).not.toHaveBeenCalled()
    expect(api.uploadStatus).toHaveBeenCalledWith('old', undefined)
    expect(send.mock.calls.map(([r]) => r.url)).toEqual(['/api/uploads/old/chunks/1'])
    expect(progress[0]).toBe(20)
    expect(asset.id).toBe('asset-old')
  })

  it('starts over when the remembered upload is gone (404)', async () => {
    const { uploader, api, resume } = setup()
    const file = makeFile(10)
    resume.map.set(fileFingerprint(file), { uploadId: 'gone', chunkSize: CHUNK, createdAt: 0 })
    api.uploadStatus.mockRejectedValueOnce(new ApiError(404, 'unknown upload'))
    await uploader.upload(file)
    expect(api.initUpload).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledWith('u1', undefined)
  })

  it('restarts once when the server forgets the upload mid-way', async () => {
    let expiredOnce = false
    const { uploader, api } = setup(async (req) => {
      if (req.url.includes('/u1/') && !expiredOnce) {
        expiredOnce = true
        throw new ApiError(410, 'expired')
      }
    })
    const asset = await uploader.upload(makeFile(20))
    expect(api.initUpload).toHaveBeenCalledTimes(2)
    expect(asset.id).toBe('asset-u2')
  })

  it('remembers the upload id per file fingerprint while in progress', async () => {
    const { uploader, resume } = setup(async () => {
      expect(resume.map.get(fileFingerprint(file))?.uploadId).toBe('u1')
    })
    const file = makeFile(10)
    await uploader.upload(file)
    expect(resume.set).toHaveBeenCalledOnce()
  })

  it('cancels with AbortError and keeps the resume record', async () => {
    const ctrl = new AbortController()
    const { uploader, api, resume } = setup(
      (req) =>
        new Promise<void>((_, reject) => {
          req.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
          ctrl.abort(new DOMException('cancelled', 'AbortError'))
        }),
    )
    await expect(uploader.upload(makeFile(30), { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(resume.map.size).toBe(1)
  })

  it('rejects immediately when already aborted', async () => {
    const { uploader, api } = setup()
    await expect(
      uploader.upload(makeFile(5), { signal: AbortSignal.abort() }),
    ).rejects.toBeDefined()
    expect(api.initUpload).not.toHaveBeenCalled()
  })

  it('completes empty files without sending chunks', async () => {
    const { uploader, send, api } = setup()
    await uploader.upload(makeFile(0))
    expect(send).not.toHaveBeenCalled()
    expect(api.completeUpload).toHaveBeenCalledOnce()
  })

  it('handles a 1 GB file without allocating it (sizes only)', async () => {
    const GB = 1024 ** 3
    const api = makeApi()
    api.initUpload.mockResolvedValue({ uploadId: 'big', chunkSize: 8 * 1024 * 1024 })
    const sizes: number[] = []
    // A File-like whose slice() returns lightweight Blobs: no 1 GB buffer is ever created.
    const huge = {
      name: 'huge.mov',
      size: GB,
      type: 'video/quicktime',
      lastModified: 1,
      slice: (start: number, end: number) => ({ size: end - start }) as Blob,
    } as unknown as File
    const uploader = new Uploader({
      api: api as unknown as ApiClient,
      resume: new MemoryResume(),
      sendChunk: async (req) => void sizes.push(req.blob.size),
    })
    await uploader.upload(huge)
    expect(sizes).toHaveLength(128)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(GB)
  })
})

describe('fileFingerprint', () => {
  it('identifies a file by name, size, mtime and type', () => {
    expect(fileFingerprint(makeFile(3, 'a.mp4'))).toBe('a.mp4|3|1234|video/mp4')
    expect(fileFingerprint(makeFile(3, 'a.mp4'))).not.toBe(fileFingerprint(makeFile(4, 'a.mp4')))
  })
})
