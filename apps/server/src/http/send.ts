/**
 * File responses with HTTP caching and byte ranges, used for media (originals, proxies,
 * exports), derived files, pack files and the web build.
 *
 * - `Range: bytes=a-b` / `a-` / `-n` → 206 + Content-Range; unsatisfiable → 416.
 *   Multi-range requests get the full body (allowed by RFC 9110 and what browsers expect).
 * - Strong ETag from size+mtime; If-None-Match / If-Modified-Since → 304; If-Range honoured.
 * - Bodies are streamed with a 256 KiB read buffer (fewer syscalls than the 64 KiB default
 *   when a phone scrubs through a proxy).
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { HttpError } from './errors.ts'

export type CachePolicy = 'immutable' | 'revalidate' | 'no-store'

const CACHE_HEADER: Record<CachePolicy, string> = {
  // Private: media is behind auth and must not land in shared caches.
  immutable: 'private, max-age=31536000, immutable',
  revalidate: 'no-cache',
  'no-store': 'no-store',
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.cube': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.crt': 'application/x-x509-ca-cert',
}

/** Content-Type for a file name (application/octet-stream if unknown). */
export const contentTypeFor = (file: string): string =>
  TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

export type ByteRange = { start: number; end: number }

/**
 * Parses a Range header against a resource of `size` bytes.
 * Returns undefined (ignore → 200), 'unsatisfiable' (416) or the inclusive byte range.
 */
export const parseRange = (
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | undefined => {
  if (!header) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return undefined // malformed or multi-range: serve the full body
  const [, a, b] = m
  if (a === '' && b === '') return undefined
  let start: number
  let end: number
  if (a === '') {
    const suffix = Number(b)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
    if (b !== '' && Number(b) < start) return undefined // invalid → ignore
  }
  if (start >= size || size === 0) return 'unsatisfiable'
  return { start, end }
}

export interface SendFileOptions {
  type?: string
  cache: CachePolicy
  /** Sets Content-Disposition: attachment with this file name. */
  downloadName?: string
}

const etagMatches = (header: string | undefined, etag: string): boolean => {
  if (!header) return false
  if (header.trim() === '*') return true
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export const attachmentHeader = (name: string): string => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** Sends `file` honouring Range and conditional headers. 404s when the file is missing. */
export const sendFile = async (
  req: FastifyRequest,
  reply: FastifyReply,
  file: string,
  opts: SendFileOptions,
): Promise<FastifyReply> => {
  let st
  try {
    st = await stat(file)
  } catch {
    throw new HttpError(404, 'not_found', 'file not found')
  }
  if (!st.isFile()) throw new HttpError(404, 'not_found', 'file not found')
  const size = st.size
  const etag = `"${size.toString(36)}-${Math.trunc(st.mtimeMs).toString(36)}"`
  const lastModified = st.mtime.toUTCString()
  reply
    .header('etag', etag)
    .header('last-modified', lastModified)
    .header('cache-control', CACHE_HEADER[opts.cache])
    .header('accept-ranges', 'bytes')
    .header('content-type', opts.type ?? contentTypeFor(file))
  if (opts.downloadName) reply.header('content-disposition', attachmentHeader(opts.downloadName))

  const h = req.headers
  const notModified =
    h['if-none-match'] !== undefined
      ? etagMatches(h['if-none-match'], etag)
      : h['if-modified-since'] !== undefined &&
        Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(h['if-modified-since']) / 1000)
  if (notModified) return reply.code(304).send()

  let range = parseRange(h.range, size)
  const ifRange = h['if-range'] as string | undefined
  if (range !== undefined && ifRange !== undefined) {
    const fresh = ifRange.startsWith('"') ? ifRange === etag : ifRange === lastModified
    if (!fresh) range = undefined
  }
  if (range === 'unsatisfiable')
    return reply
      .code(416)
      .header('content-range', `bytes */${size}`)
      .header('cache-control', 'no-store')
      .header('content-type', 'application/json; charset=utf-8')
      .send({ error: { code: 'range_not_satisfiable', message: 'range not satisfiable' } })

  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`)
  reply.header('content-length', String(length))
  // HEAD: an empty stream keeps our Content-Length (Fastify resets it for empty bodies)
  // without opening the file.
  if (req.method === 'HEAD') return reply.send(Readable.from([]))
  if (length === 0) return reply.send()
  return reply.send(createReadStream(file, { start, end, highWaterMark: 256 * 1024 }))
}
