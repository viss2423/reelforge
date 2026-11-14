/**
 * Resumable, verified downloads.
 *
 * - Data streams to `<dest>.part`; an interrupted run resumes with an HTTP Range request
 *   (falls back to a fresh download if the server ignores ranges).
 * - SHA-256 is computed while streaming (the existing prefix is hashed once on resume), so
 *   verification costs no extra pass over multi-GB models.
 * - The final file appears atomically (rename) and a `<dest>.sha256` stamp (hash, size,
 *   mtime) lets re-runs skip re-hashing unchanged files — setup stays idempotent and fast.
 */
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Progress } from './progress.ts'

export interface DownloadOptions {
  url: string
  dest: string
  /** Expected lowercase hex SHA-256. Strongly recommended. */
  sha256?: string
  /** Expected size in bytes (used for progress and an early sanity check). */
  size?: number
  label?: string
  /** Re-download even if a verified file exists. */
  force?: boolean
  retries?: number
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Silence the progress bar (tests). */
  quiet?: boolean
}

export type DownloadStatus = 'downloaded' | 'resumed' | 'cached'

export interface DownloadResult {
  status: DownloadStatus
  path: string
  sha256: string
  size: number
}

export class ChecksumError extends Error {
  readonly expected: string
  readonly actual: string
  constructor(file: string, expected: string, actual: string) {
    super(`sha256 mismatch for ${path.basename(file)}: expected ${expected}, got ${actual}`)
    this.name = 'ChecksumError'
    this.expected = expected
    this.actual = actual
  }
}

interface Stamp {
  sha256: string
  size: number
  mtimeMs: number
}

const stampPath = (dest: string): string => `${dest}.sha256`

const readStamp = async (dest: string): Promise<Stamp | undefined> => {
  try {
    const [sha256 = '', size = '', mtimeMs = ''] = (await readFile(stampPath(dest), 'utf8'))
      .trim()
      .split(/\s+/)
    return { sha256, size: Number(size), mtimeMs: Number(mtimeMs) }
  } catch {
    return undefined
  }
}

const writeStamp = async (dest: string, sha256: string): Promise<void> => {
  const st = await stat(dest)
  await writeFile(stampPath(dest), `${sha256} ${st.size} ${st.mtimeMs}\n`)
}

/** Streaming SHA-256 of a file (1 MiB reads). */
export const sha256File = async (
  file: string,
  hash: Hash = createHash('sha256'),
): Promise<string> => {
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 }))
    hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const fileSize = async (file: string): Promise<number | undefined> => {
  try {
    return (await stat(file)).size
  } catch {
    return undefined
  }
}

/**
 * Returns the verified hash of an existing `dest` if it matches `sha256` (or if no hash is
 * expected), using the stamp to avoid re-hashing. Returns undefined if it must be fetched.
 */
export const verifyExisting = async (
  dest: string,
  sha256?: string,
): Promise<string | undefined> => {
  const st = await stat(dest).catch(() => undefined)
  if (!st) return undefined
  const stamp = await readStamp(dest)
  if (stamp && stamp.size === st.size && stamp.mtimeMs === st.mtimeMs) {
    return !sha256 || stamp.sha256 === sha256 ? stamp.sha256 : undefined
  }
  const actual = await sha256File(dest)
  if (sha256 && actual !== sha256) return undefined
  await writeStamp(dest, actual)
  return actual
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason as Error)
      },
      { once: true },
    )
  })

/** HTTP status codes that are worth retrying. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

class HttpError extends Error {
  readonly status: number
  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`)
    this.status = status
  }
}

/** One attempt: resume from `.part` if possible. Returns the computed hash and whether it resumed. */
const attempt = async (
  opts: DownloadOptions,
  part: string,
): Promise<{ sha256: string; size: number; resumed: boolean }> => {
  const have = (await fileSize(part)) ?? 0
  // identity: byte ranges and Content-Length must refer to the stored bytes, not a gzip stream.
  const headers: Record<string, string> = {
    'user-agent': 'reelforge-setup',
    'accept-encoding': 'identity',
    ...opts.headers,
  }
  if (have > 0) headers.range = `bytes=${have}-`
  const res = await fetch(opts.url, { headers, redirect: 'follow', signal: opts.signal ?? null })

  // 416: the .part already holds the full file (or is garbage) — verify it as-is.
  if (res.status === 416 && have > 0) {
    await res.body?.cancel()
    return { sha256: await sha256File(part), size: have, resumed: true }
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel()
    throw new HttpError(opts.url, res.status)
  }
  const resumed = res.status === 206 && have > 0
  const hash = createHash('sha256')
  if (resumed) {
    // Hash the prefix we already have so the final digest covers the whole file.
    for await (const chunk of createReadStream(part, { highWaterMark: 1 << 20 }))
      hash.update(chunk as Buffer)
  }
  const encoded = (res.headers.get('content-encoding') ?? 'identity') !== 'identity'
  const len = encoded ? NaN : Number(res.headers.get('content-length') ?? NaN)
  const total = Number.isFinite(len) ? len + (resumed ? have : 0) : opts.size
  if (opts.size !== undefined && total !== undefined && total !== opts.size) {
    await res.body.cancel()
    await rm(part, { force: true })
    throw new Error(`size mismatch for ${opts.url}: expected ${opts.size}, server reports ${total}`)
  }

  const progress = opts.quiet
    ? undefined
    : new Progress({ label: opts.label ?? path.basename(opts.dest), total })
  progress?.setBase(resumed ? have : 0, total)
  let written = resumed ? have : 0
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      written += chunk.length
      progress?.tick(chunk.length)
      cb(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>),
    tap,
    createWriteStream(part, { flags: resumed ? 'a' : 'w', highWaterMark: 1 << 20 }),
    { signal: opts.signal },
  )
  progress?.done(resumed ? '(resumed)' : '')
  return { sha256: hash.digest('hex'), size: written, resumed }
}

/**
 * Download `url` to `dest`, resuming partial downloads and verifying SHA-256. Idempotent:
 * an existing verified file returns `{ status: 'cached' }` without network access.
 */
export const download = async (opts: DownloadOptions): Promise<DownloadResult> => {
  const expected = opts.sha256?.toLowerCase()
  await mkdir(path.dirname(opts.dest), { recursive: true })
  if (!opts.force) {
    const existing = await verifyExisting(opts.dest, expected)
    if (existing) {
      return {
        status: 'cached',
        path: opts.dest,
        sha256: existing,
        size: (await fileSize(opts.dest)) ?? 0,
      }
    }
  }
  const part = `${opts.dest}.part`
  if (opts.force) await rm(part, { force: true })
  const retries = opts.retries ?? 4
  let lastError: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await attempt(opts, part)
      if (expected && r.sha256 !== expected) {
        // A corrupt prefix would poison every resume — start over next time.
        await rm(part, { force: true })
        throw new ChecksumError(opts.dest, expected, r.sha256)
      }
      await rm(opts.dest, { force: true })
      await rename(part, opts.dest)
      await writeStamp(opts.dest, r.sha256)
      return {
        status: r.resumed ? 'resumed' : 'downloaded',
        path: opts.dest,
        sha256: r.sha256,
        size: r.size,
      }
    } catch (err) {
      lastError = err
      if (opts.signal?.aborted) throw err
      const fatal =
        (err instanceof HttpError && !RETRYABLE.has(err.status)) ||
        (err instanceof ChecksumError && i >= 1)
      if (fatal || i === retries) break
      await sleep(Math.min(8000, 500 * 2 ** i), opts.signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** GET JSON with optional GitHub token; small helper for release/metadata APIs. */
export const fetchJson = async <T>(url: string, signal?: AbortSignal): Promise<T> => {
  const headers: Record<string, string> = {
    'user-agent': 'reelforge-setup',
    accept: 'application/json',
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token && new URL(url).hostname === 'api.github.com') headers.authorization = `Bearer ${token}`
  const res = await fetch(url, { headers, signal: signal ?? null })
  if (!res.ok) throw new HttpError(url, res.status)
  return (await res.json()) as T
}
