/**
 * Chunked, resumable, parallel uploader.
 *
 * Designed for multi-GB 4K phone videos: the file is never read into memory — each chunk is
 * a `Blob.slice()` view streamed by the browser. Chunks (size dictated by the server,
 * normally 8 MB) are sent `parallel` at a time, each retried with exponential backoff on
 * network errors / 5xx / 408 / 429. Upload ids are remembered per file fingerprint in
 * IndexedDB so an interrupted upload (tab closed, network lost) resumes from the chunks the
 * server already has (`GET /api/uploads/:id`).
 */
import type { Asset } from '@reelforge/core'
import { backoffDelay, isAbortError, sleep } from '@/lib/backoff.ts'
import { idbDelete, idbGet, idbSet } from '@/lib/idb.ts'
import { ApiError, type ApiClient } from './client.ts'

export interface UploadProgress {
  loaded: number
  total: number
}

export interface ChunkRequest {
  url: string
  blob: Blob
  headers: Record<string, string>
  signal: AbortSignal
  /** Bytes of this chunk sent so far (may be called many times). */
  onProgress: (loaded: number) => void
}

/** Sends one chunk; rejects with `ApiError` (status 0 for network failures) or AbortError. */
export type ChunkSender = (req: ChunkRequest) => Promise<void>

export interface ResumeRecord {
  uploadId: string
  chunkSize: number
  createdAt: number
}

export interface ResumeStore {
  get(fingerprint: string): Promise<ResumeRecord | undefined>
  set(fingerprint: string, rec: ResumeRecord): Promise<void>
  delete(fingerprint: string): Promise<void>
}

/** IndexedDB-backed resume store; failures degrade to "no resume" rather than failing uploads. */
export const idbResumeStore: ResumeStore = {
  get: (fp) => idbGet<ResumeRecord>('uploads', fp).catch(() => undefined),
  set: (fp, rec) => idbSet('uploads', fp, rec).catch(() => undefined),
  delete: (fp) => idbDelete('uploads', fp).catch(() => undefined),
}

/** Byte-accurate progress via XMLHttpRequest (fetch has no upload progress). */
export const xhrChunkSender: ChunkSender = ({ url, blob, headers, signal, onProgress }) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const done = () => signal.removeEventListener('abort', onAbort)
    xhr.open('PUT', url)
    xhr.withCredentials = true
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      done()
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new ApiError(xhr.status, `chunk upload failed (${xhr.status})`, xhr.responseText))
    }
    xhr.onerror = () => {
      done()
      reject(new ApiError(0, 'network error during chunk upload'))
    }
    xhr.ontimeout = xhr.onerror
    xhr.onabort = () => {
      done()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    xhr.send(blob)
  })

export interface UploaderOptions {
  api: ApiClient
  sendChunk?: ChunkSender
  resume?: ResumeStore
  /** Concurrent chunk requests per file. */
  parallel?: number
  /** Retries per chunk before giving up. */
  maxRetries?: number
  /** Base delay for backoff (ms). */
  retryBaseMs?: number
}

export interface UploadFileOptions {
  signal?: AbortSignal
  onProgress?: (p: UploadProgress) => void
}

/** Identity of a local file for resume purposes (no hashing: hashing 1 GB would be slow). */
export const fileFingerprint = (file: File): string =>
  `${file.name}|${file.size}|${file.lastModified}|${file.type}`

class UploadExpired extends Error {}

export class Uploader {
  private readonly api: ApiClient
  private readonly sendChunk: ChunkSender
  private readonly resume: ResumeStore
  private readonly parallel: number
  private readonly maxRetries: number
  private readonly retryBaseMs: number

  constructor(opts: UploaderOptions) {
    this.api = opts.api
    this.sendChunk = opts.sendChunk ?? xhrChunkSender
    this.resume = opts.resume ?? idbResumeStore
    this.parallel = Math.max(1, opts.parallel ?? 3)
    this.maxRetries = opts.maxRetries ?? 6
    this.retryBaseMs = opts.retryBaseMs ?? 500
  }

  /** Uploads `file` and resolves with the created Asset. Rejects with AbortError on cancel. */
  async upload(file: File, opts: UploadFileOptions = {}): Promise<Asset> {
    const fp = fileFingerprint(file)
    try {
      return await this.attempt(file, fp, opts)
    } catch (err) {
      if (!(err instanceof UploadExpired)) throw err
      // The server forgot the upload (expired/garbage-collected): start over once.
      await this.resume.delete(fp)
      return this.attempt(file, fp, opts)
    }
  }

  private async attempt(file: File, fp: string, opts: UploadFileOptions): Promise<Asset> {
    const { signal } = opts
    signal?.throwIfAborted()
    const { uploadId, chunkSize, received } = await this.session(file, fp, signal)
    const total = file.size
    const count = Math.ceil(total / chunkSize)
    const sizeOf = (i: number) => Math.min(chunkSize, total - i * chunkSize)

    let done = 0
    const pending: number[] = []
    for (let i = 0; i < count; i++) {
      if (received.has(i)) done += sizeOf(i)
      else pending.push(i)
    }
    const inflight = new Map<number, number>()
    let lastReport = -1
    const report = () => {
      let loaded = done
      for (const v of inflight.values()) loaded += v
      if (loaded !== lastReport) {
        lastReport = loaded
        opts.onProgress?.({ loaded, total })
      }
    }
    report()

    // One failing chunk cancels its siblings instead of letting them burn bandwidth.
    const ctrl = new AbortController()
    const onOuterAbort = () => ctrl.abort(signal?.reason)
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    const headers = this.api.authHeaders()
    let next = 0
    const worker = async () => {
      while (next < pending.length) {
        const index = pending[next++]!
        await this.sendWithRetry(
          {
            url: this.api.chunkUrl(uploadId, index),
            blob: file.slice(index * chunkSize, index * chunkSize + sizeOf(index)),
            headers,
            signal: ctrl.signal,
            onProgress: (loaded) => {
              inflight.set(index, loaded)
              report()
            },
          },
          () => inflight.set(index, 0),
        )
        inflight.delete(index)
        done += sizeOf(index)
        report()
      }
    }
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.parallel, pending.length) }, async () => {
          try {
            await worker()
          } catch (err) {
            ctrl.abort(err)
            throw err
          }
        }),
      )
    } finally {
      signal?.removeEventListener('abort', onOuterAbort)
    }
    signal?.throwIfAborted()
    const asset = await this.api.completeUpload(uploadId, signal)
    await this.resume.delete(fp)
    return asset
  }

  /** Resumes a known upload for this file or starts a new one. */
  private async session(
    file: File,
    fp: string,
    signal: AbortSignal | undefined,
  ): Promise<{ uploadId: string; chunkSize: number; received: Set<number> }> {
    const known = await this.resume.get(fp)
    if (known) {
      try {
        const status = await this.retrying(
          () => this.api.uploadStatus(known.uploadId, signal),
          signal,
        )
        return { ...known, received: new Set(status.received) }
      } catch (err) {
        if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 410)) throw err
        await this.resume.delete(fp)
      }
    }
    const init = await this.retrying(
      () =>
        this.api.initUpload({
          name: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
        }),
      signal,
    )
    await this.resume.set(fp, {
      uploadId: init.uploadId,
      chunkSize: init.chunkSize,
      createdAt: Date.now(),
    })
    return { uploadId: init.uploadId, chunkSize: init.chunkSize, received: new Set() }
  }

  private async sendWithRetry(req: ChunkRequest, onRetry: () => void): Promise<void> {
    await this.retrying(
      () => this.sendChunk(req),
      req.signal,
      (err) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 410))
          throw new UploadExpired()
        onRetry()
      },
    )
  }

  /** Runs `fn`, retrying retryable failures with backoff. */
  private async retrying<T>(
    fn: () => Promise<T>,
    signal: AbortSignal | undefined,
    onError?: (err: unknown) => void,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw err
        onError?.(err)
        const retryable = !(err instanceof ApiError) || err.retryable
        if (!retryable || attempt >= this.maxRetries) throw err
        await sleep(backoffDelay(attempt, { base: this.retryBaseMs, max: 30_000 }), signal)
      }
    }
  }
}
