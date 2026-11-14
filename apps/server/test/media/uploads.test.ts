import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DataPaths } from '../../src/contracts.ts'
import { SqliteStore } from '../../src/db/store.ts'
import { assetFile } from '../../src/paths.ts'
import {
  kindFor,
  sanitizeName,
  UploadError,
  Uploads,
  uploadTempFile,
} from '../../src/media/uploads.ts'
import { tempData } from '../helpers.ts'

const CHUNK = 64 * 1024

/** Splits `buf` into a stream of small pieces so writes exercise batching. */
const body = (buf: Buffer, piece = 7_919): Readable => {
  const parts: Buffer[] = []
  for (let i = 0; i < buf.length; i += piece) parts.push(buf.subarray(i, i + piece))
  return Readable.from(parts)
}

const chunkOf = (data: Buffer, i: number): Buffer => data.subarray(i * CHUNK, (i + 1) * CHUNK)

describe('Uploads', () => {
  let paths: DataPaths
  let store: SqliteStore
  let uploads: Uploads
  let cleanup: () => Promise<void>

  const service = (over: Partial<ConstructorParameters<typeof Uploads>[0]> = {}): Uploads =>
    new Uploads({
      store,
      paths,
      maxUploadBytes: 10 * 1024 * 1024,
      chunkSize: CHUNK,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      ...over,
    })

  beforeEach(async () => {
    ;({ paths, cleanup } = await tempData())
    store = new SqliteStore(paths.db)
    uploads = service()
  })
  afterEach(async () => {
    store.close()
    await cleanup()
  })

  it('preallocates the temp file and reports chunk layout', async () => {
    const s = await uploads.create({ name: 'clip.mp4', size: CHUNK * 2 + 10, mime: 'video/mp4' })
    expect(s).toMatchObject({ size: CHUNK * 2 + 10, chunkSize: CHUNK, chunks: 3, received: [] })
    expect((await stat(uploadTempFile(paths, s.uploadId))).size).toBe(CHUNK * 2 + 10)
  })

  it('accepts out-of-order, parallel chunks and assembles the exact bytes', async () => {
    const data = randomBytes(CHUNK * 4 + 1234)
    const s = await uploads.create({
      name: '../../evil/My Clip.MOV',
      size: data.length,
      mime: 'video/quicktime',
    })
    // Last, first, then the middle three in parallel.
    await uploads.writeChunk(s.uploadId, 4, body(chunkOf(data, 4)))
    await uploads.writeChunk(s.uploadId, 0, body(chunkOf(data, 0)), CHUNK)
    const results = await Promise.all(
      [2, 1, 3].map((i) => uploads.writeChunk(s.uploadId, i, body(chunkOf(data, i)))),
    )
    expect(results.every((r) => !r.duplicate && r.chunks === 5)).toBe(true)
    expect(uploads.status(s.uploadId).received).toEqual([0, 1, 2, 3, 4])

    const asset = await uploads.complete(s.uploadId)
    expect(asset).toMatchObject({
      kind: 'video',
      name: 'My Clip.MOV',
      size: data.length,
      mime: 'video/quicktime',
      proxy: 'pending',
    })
    const file = assetFile(paths, asset, 'original')
    expect(file.endsWith('original.mov')).toBe(true)
    expect((await readFile(file)).equals(data)).toBe(true)
    expect(store.getAsset(asset.id)?.id).toBe(asset.id)
    expect(store.getUpload(s.uploadId)).toBeUndefined()
    expect(existsSync(uploadTempFile(paths, s.uploadId))).toBe(false)
  })

  it('is idempotent: re-sending a received chunk is acknowledged without rewriting', async () => {
    const data = randomBytes(CHUNK * 2)
    const s = await uploads.create({ name: 'a.mp4', size: data.length, mime: 'video/mp4' })
    expect(await uploads.writeChunk(s.uploadId, 0, body(chunkOf(data, 0)))).toEqual({
      received: 1,
      chunks: 2,
      duplicate: false,
    })
    // A retry with different bytes must not clobber what was acknowledged.
    const again = await uploads.writeChunk(s.uploadId, 0, body(Buffer.alloc(CHUNK, 1)))
    expect(again).toEqual({ received: 1, chunks: 2, duplicate: true })
    await uploads.writeChunk(s.uploadId, 1, body(chunkOf(data, 1)))
    const asset = await uploads.complete(s.uploadId)
    expect((await readFile(assetFile(paths, asset, 'original'))).equals(data)).toBe(true)
  })

  it('resumes from the persisted bitmap after a restart', async () => {
    const data = randomBytes(CHUNK * 3)
    const s = await uploads.create({ name: 'song.mp3', size: data.length, mime: 'audio/mpeg' })
    await uploads.writeChunk(s.uploadId, 1, body(chunkOf(data, 1)))
    // "Restart": a new store + service over the same files.
    store.close()
    store = new SqliteStore(paths.db)
    uploads = service()
    expect(uploads.status(s.uploadId).received).toEqual([1])
    await expect(uploads.complete(s.uploadId)).rejects.toMatchObject({
      status: 409,
      code: 'incomplete',
      details: { missing: [0, 2] },
    })
    await uploads.writeChunk(s.uploadId, 0, body(chunkOf(data, 0)))
    await uploads.writeChunk(s.uploadId, 2, body(chunkOf(data, 2)))
    const asset = await uploads.complete(s.uploadId)
    expect(asset.kind).toBe('audio')
    expect((await readFile(assetFile(paths, asset, 'original'))).equals(data)).toBe(true)
  })

  it('rejects chunks of the wrong size without marking them', async () => {
    const s = await uploads.create({ name: 'a.mp4', size: CHUNK + 100, mime: 'video/mp4' })
    // Declared length mismatch is rejected before reading.
    await expect(
      uploads.writeChunk(s.uploadId, 0, body(Buffer.alloc(10)), 10),
    ).rejects.toMatchObject({
      status: 400,
      code: 'chunk_size_mismatch',
      details: { expected: CHUNK },
    })
    // Short body (truncated transfer).
    await expect(
      uploads.writeChunk(s.uploadId, 0, body(Buffer.alloc(CHUNK - 1))),
    ).rejects.toMatchObject({
      code: 'chunk_size_mismatch',
      details: { expected: CHUNK, received: CHUNK - 1 },
    })
    // Oversized body for the short last chunk.
    await expect(uploads.writeChunk(s.uploadId, 1, body(Buffer.alloc(101)))).rejects.toMatchObject({
      code: 'chunk_size_mismatch',
    })
    expect(uploads.status(s.uploadId).received).toEqual([])
    // Correct sizes then succeed.
    await uploads.writeChunk(s.uploadId, 1, body(Buffer.alloc(100)))
    expect(uploads.status(s.uploadId).received).toEqual([1])
  })

  it('validates chunk indices and unknown uploads', async () => {
    const s = await uploads.create({ name: 'a.mp4', size: 10, mime: 'video/mp4' })
    for (const i of [-1, 1, 0.5]) {
      await expect(uploads.writeChunk(s.uploadId, i, body(Buffer.alloc(10)))).rejects.toMatchObject(
        { status: 400, code: 'invalid_chunk' },
      )
    }
    await expect(uploads.writeChunk('u_missing', 0, body(Buffer.alloc(1)))).rejects.toBeInstanceOf(
      UploadError,
    )
    expect(() => uploads.status('u_missing')).toThrow(/not found/)
    await expect(uploads.complete('u_missing')).rejects.toMatchObject({ status: 404 })
  })

  it('validates size, type and free disk space on create', async () => {
    const create = (name: string, size: number, mime: string) =>
      uploads.create({ name, size, mime })
    await expect(create('a.mp4', 0, 'video/mp4')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_size',
    })
    await expect(create('a.mp4', 1.5, 'video/mp4')).rejects.toMatchObject({ code: 'invalid_size' })
    await expect(create('a.mp4', 10 * 1024 * 1024 + 1, 'video/mp4')).rejects.toMatchObject({
      status: 413,
      code: 'too_large',
    })
    await expect(create('a.exe', 10, 'application/x-msdownload')).rejects.toMatchObject({
      status: 415,
      code: 'unsupported_type',
    })
    const full = service({ freeBytes: async () => 1024 })
    await expect(full.create({ name: 'a.mp4', size: 10, mime: 'video/mp4' })).rejects.toMatchObject(
      { status: 507 },
    )
  })

  it('abort removes the upload and its temp file', async () => {
    const s = await uploads.create({ name: 'a.png', size: 10, mime: 'image/png' })
    await uploads.abort(s.uploadId)
    expect(store.getUpload(s.uploadId)).toBeUndefined()
    expect(existsSync(uploadTempFile(paths, s.uploadId))).toBe(false)
    await expect(uploads.abort(s.uploadId)).rejects.toMatchObject({ status: 404 })
  })
})

describe('kindFor / sanitizeName', () => {
  it('maps MIME types and falls back to the extension for generic types', () => {
    expect(kindFor('video/mp4', 'a.mp4')).toBe('video')
    expect(kindFor('VIDEO/QUICKTIME', 'a.mov')).toBe('video')
    expect(kindFor('image/gif', 'a.gif')).toBe('video')
    expect(kindFor('audio/x-m4a', 'a.m4a')).toBe('audio')
    expect(kindFor('image/heic', 'IMG_1.HEIC')).toBe('image')
    expect(kindFor('image/svg+xml', 'a.svg')).toBeUndefined()
    expect(kindFor('application/octet-stream', 'a.MKV')).toBe('video')
    expect(kindFor('', 'a.wav')).toBe('audio')
    expect(kindFor('', 'a.txt')).toBeUndefined()
    expect(kindFor('text/html', 'a.mp4')).toBeUndefined()
  })

  it('strips paths and control characters', () => {
    expect(sanitizeName('C:\\Users\\x\\clip.mp4')).toBe('clip.mp4')
    expect(sanitizeName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeName('a\u0000b\nc.mp4')).toBe('abc.mp4')
    expect(sanitizeName('/')).toBe('upload')
    expect(sanitizeName('x'.repeat(300))).toHaveLength(200)
  })
})
