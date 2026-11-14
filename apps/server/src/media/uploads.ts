/**
 * Chunked, resumable uploads.
 *
 * The client announces `{ name, size, mime }`; the server preallocates a temp file of the
 * final size and the client PUTs fixed 8 MiB chunks (any order, in parallel, retried at
 * will). Each chunk is streamed straight to its offset with positional vectored writes — no
 * buffering of whole chunks, no reassembly pass. A per-upload bitmap in SQLite records which
 * chunks arrived, so an interrupted upload (phone locked, Wi-Fi drop) resumes where it left off.
 */
import { mkdir, open, rename, rm, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { newId, type Asset, type AssetKind } from '@reelforge/core'
import type { DataPaths } from '../contracts.ts'
import { bitmapIndices, type SqliteStore, type UploadRecord } from '../db/store.ts'
import { assetDir, assetFile } from '../paths.ts'

export const CHUNK_SIZE = 8 * 1024 * 1024
/** Coalesce socket reads into ~1 MiB writes to keep syscalls (and threadpool hops) low. */
const WRITE_BATCH = 1024 * 1024
/** Free space we always leave on the disk. */
const DISK_HEADROOM = 512 * 1024 * 1024

export class UploadError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const EXT_KIND: Record<string, AssetKind> = {
  '.mp4': 'video',
  '.m4v': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.webm': 'video',
  '.avi': 'video',
  '.3gp': 'video',
  '.mts': 'video',
  '.ts': 'video',
  '.gif': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
  '.aiff': 'audio',
  '.aif': 'audio',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.heic': 'image',
  '.heif': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.tif': 'image',
  '.tiff': 'image',
}

/**
 * Asset kind implied by the MIME type (or the extension for generic/unknown MIME types).
 * Undefined → not a media file we accept. The probe job later determines the real kind.
 */
export const kindFor = (mime: string, name: string): AssetKind | undefined => {
  const m = mime.toLowerCase()
  const ext = path.extname(name).toLowerCase()
  if (m === 'image/gif') return 'video'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('image/') && m !== 'image/svg+xml') return EXT_KIND[ext] ?? 'image'
  if (m === '' || m === 'application/octet-stream' || m === 'binary/octet-stream')
    return EXT_KIND[ext]
  return undefined
}

/** Strips directories and control characters from a client-supplied file name. */
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

export const sanitizeName = (name: string): string => {
  const base = name.replaceAll('\\', '/').split('/').pop()!.replace(CONTROL_CHARS, '').trim()
  return (base || 'upload').slice(0, 200)
}

export const uploadTempFile = (paths: DataPaths, id: string): string =>
  path.join(paths.tmp, 'uploads', `${id}.part`)

export interface UploadStatus {
  uploadId: string
  size: number
  chunkSize: number
  chunks: number
  received: number[]
}

export interface UploadsDeps {
  store: SqliteStore
  paths: DataPaths
  maxUploadBytes: number
  chunkSize?: number
  /** Free bytes on the volume holding `dir` (injectable for tests). */
  freeBytes?: (dir: string) => Promise<number>
}

const defaultFreeBytes = async (dir: string): Promise<number> => {
  const s = await statfs(dir)
  return s.bavail * s.bsize
}

export class Uploads {
  readonly #deps: UploadsDeps
  readonly #chunkSize: number
  readonly #completing = new Set<string>()

  constructor(deps: UploadsDeps) {
    this.#deps = deps
    this.#chunkSize = deps.chunkSize ?? CHUNK_SIZE
  }

  #get(id: string): UploadRecord {
    const u = this.#deps.store.getUpload(id)
    if (!u) throw new UploadError(404, 'not_found', 'upload not found')
    return u
  }

  /** Validates and registers an upload; preallocates its temp file. */
  async create(
    input: { name: string; size: number; mime: string },
    deviceId?: string,
  ): Promise<UploadStatus> {
    const name = sanitizeName(input.name)
    if (!Number.isSafeInteger(input.size) || input.size <= 0)
      throw new UploadError(400, 'invalid_size', 'size must be a positive integer')
    if (input.size > this.#deps.maxUploadBytes)
      throw new UploadError(
        413,
        'too_large',
        `file exceeds the ${this.#deps.maxUploadBytes} byte limit`,
      )
    if (!kindFor(input.mime, name))
      throw new UploadError(
        415,
        'unsupported_type',
        `unsupported media type: ${input.mime || 'unknown'}`,
      )
    const dir = path.join(this.#deps.paths.tmp, 'uploads')
    await mkdir(dir, { recursive: true })
    const free = await (this.#deps.freeBytes ?? defaultFreeBytes)(dir)
    if (free < input.size + DISK_HEADROOM)
      throw new UploadError(
        507,
        'insufficient_storage',
        'not enough free disk space for this upload',
      )

    const id = newId('u')
    const fh = await open(uploadTempFile(this.#deps.paths, id), 'w')
    try {
      await fh.truncate(input.size)
    } finally {
      await fh.close()
    }
    const rec = this.#deps.store.insertUpload({
      id,
      name,
      mime: input.mime.toLowerCase(),
      size: input.size,
      chunkSize: this.#chunkSize,
      chunks: Math.ceil(input.size / this.#chunkSize),
      ...(deviceId ? { deviceId } : {}),
      createdAt: new Date().toISOString(),
    })
    return this.#status(rec)
  }

  #status(u: UploadRecord): UploadStatus {
    return {
      uploadId: u.id,
      size: u.size,
      chunkSize: u.chunkSize,
      chunks: u.chunks,
      received: bitmapIndices(u.received, u.chunks),
    }
  }

  status(id: string): UploadStatus {
    return this.#status(this.#get(id))
  }

  /** Expected byte length of chunk `index`. */
  static chunkLength(
    u: Pick<UploadRecord, 'size' | 'chunkSize' | 'chunks'>,
    index: number,
  ): number {
    return index === u.chunks - 1 ? u.size - index * u.chunkSize : u.chunkSize
  }

  /**
   * Streams one chunk to its offset. Idempotent: a chunk that was already received is
   * acknowledged without rewriting. A body of the wrong length is rejected and NOT marked.
   */
  async writeChunk(
    id: string,
    index: number,
    body: Readable,
    contentLength?: number,
  ): Promise<{ received: number; chunks: number; duplicate: boolean }> {
    const u = this.#get(id)
    if (!Number.isInteger(index) || index < 0 || index >= u.chunks)
      throw new UploadError(400, 'invalid_chunk', `chunk index must be 0..${u.chunks - 1}`)
    if (this.#completing.has(id)) throw new UploadError(409, 'completing', 'upload is completing')
    const expected = Uploads.chunkLength(u, index)
    if (contentLength !== undefined && contentLength !== expected)
      throw new UploadError(
        400,
        'chunk_size_mismatch',
        `chunk ${index} must be ${expected} bytes`,
        {
          expected,
        },
      )
    if ((u.received[index >> 3]! >> (index & 7)) & 1) {
      body.resume()
      return {
        received: bitmapIndices(u.received, u.chunks).length,
        chunks: u.chunks,
        duplicate: true,
      }
    }

    const fh = await open(uploadTempFile(this.#deps.paths, id), 'r+')
    let position = index * u.chunkSize
    let written = 0
    let batch: Buffer[] = []
    let batchBytes = 0
    const flush = async (): Promise<void> => {
      if (batchBytes === 0) return
      const { bytesWritten } = await fh.writev(batch, position)
      position += bytesWritten
      batch = []
      batchBytes = 0
    }
    try {
      for await (const chunk of body as AsyncIterable<Buffer>) {
        written += chunk.length
        if (written > expected)
          throw new UploadError(
            400,
            'chunk_size_mismatch',
            `chunk ${index} exceeds ${expected} bytes`,
            {
              expected,
            },
          )
        batch.push(chunk)
        batchBytes += chunk.length
        if (batchBytes >= WRITE_BATCH) await flush()
      }
      await flush()
    } finally {
      await fh.close()
    }
    if (written !== expected)
      throw new UploadError(
        400,
        'chunk_size_mismatch',
        `chunk ${index} must be ${expected} bytes, got ${written}`,
        {
          expected,
          received: written,
        },
      )
    const marked = this.#deps.store.markChunk(id, index)
    if (!marked) throw new UploadError(404, 'not_found', 'upload not found')
    return { ...marked, duplicate: false }
  }

  /**
   * Finalises a fully received upload: moves the file into `media/<assetId>/original.<ext>`
   * and registers the Asset (state 'pending' until the probe job runs).
   */
  async complete(id: string): Promise<Asset> {
    const u = this.#get(id)
    const missing = u.chunks - bitmapIndices(u.received, u.chunks).length
    if (missing > 0) {
      const have = new Set(bitmapIndices(u.received, u.chunks))
      const list: number[] = []
      for (let i = 0; i < u.chunks && list.length < 1000; i++) if (!have.has(i)) list.push(i)
      throw new UploadError(409, 'incomplete', `${missing} chunk(s) missing`, { missing: list })
    }
    if (this.#completing.has(id))
      throw new UploadError(409, 'completing', 'upload is already completing')
    this.#completing.add(id)
    try {
      const asset: Asset = {
        id: newId('a'),
        kind: kindFor(u.mime, u.name) ?? 'video',
        name: u.name,
        size: u.size,
        mime: u.mime,
        createdAt: new Date().toISOString(),
        hasAudio: false,
        hasVideo: false,
        proxy: 'pending',
        thumbnails: 'pending',
        waveform: 'pending',
      }
      await mkdir(assetDir(this.#deps.paths, asset.id), { recursive: true })
      await rename(
        uploadTempFile(this.#deps.paths, id),
        assetFile(this.#deps.paths, asset, 'original'),
      )
      this.#deps.store.transaction(() => {
        this.#deps.store.putAsset(asset)
        this.#deps.store.deleteUpload(id)
      })
      return asset
    } finally {
      this.#completing.delete(id)
    }
  }

  /** Abandons an upload and deletes its temp file. */
  async abort(id: string): Promise<void> {
    this.#get(id)
    this.#deps.store.deleteUpload(id)
    await rm(uploadTempFile(this.#deps.paths, id), { force: true })
  }
}
