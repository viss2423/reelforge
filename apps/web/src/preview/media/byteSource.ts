/**
 * Random-access byte readers for media files. The demuxer and decoders only ever read
 * through this interface so the same code works for server proxies (HTTP Range), local
 * files in the dev harness (Blob) and in-memory buffers in tests.
 */

export interface ByteSource {
  /** Total size in bytes once known (after the first read for HTTP sources). */
  readonly size: number | undefined
  /**
   * Read `length` bytes starting at `offset`. May return fewer bytes at end of file.
   * The returned view must be treated as read-only (it may alias a shared buffer).
   */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}

/** In-memory source (tests, and the fallback when a server ignores Range requests). */
export class MemoryByteSource implements ByteSource {
  readonly #bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }
  get size(): number {
    return this.#bytes.byteLength
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    return Promise.resolve(
      this.#bytes.subarray(offset, Math.min(offset + length, this.#bytes.byteLength)),
    )
  }
}

/** Blob / File source (dev harness, drag-and-drop). Zero network; slices are lazy. */
export class BlobByteSource implements ByteSource {
  readonly #blob: Blob
  constructor(blob: Blob) {
    this.#blob = blob
  }
  get size(): number {
    return this.#blob.size
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = await this.#blob.slice(offset, offset + length).arrayBuffer()
    return new Uint8Array(buf)
  }
}

const CONTENT_RANGE = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i

/**
 * HTTP source using Range requests. Requests carry credentials (the server authenticates
 * media with an HttpOnly cookie). If the server answers 200 instead of 206 the whole body
 * is kept and subsequent reads are served from memory, so non-Range servers (or blob: URLs
 * in browsers that ignore Range on them) still work.
 */
export class HttpByteSource implements ByteSource {
  readonly url: string
  #size: number | undefined
  #whole: Promise<Uint8Array> | undefined
  readonly #fetch: typeof fetch

  constructor(url: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.url = url
    this.#fetch = fetchImpl
  }

  get size(): number | undefined {
    return this.#size
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#whole) return slice(await this.#whole, offset, length)
    if (length <= 0) return new Uint8Array(0)
    const res = await this.#fetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      credentials: 'include',
      signal: signal ?? null,
    })
    if (res.status === 416) {
      // asked past EOF
      return new Uint8Array(0)
    }
    if (!res.ok) throw new Error(`GET ${this.url} → HTTP ${res.status}`)
    if (res.status === 200) {
      // Range ignored: keep the full body and serve every future read from memory.
      this.#whole = res.arrayBuffer().then((b) => {
        const bytes = new Uint8Array(b)
        this.#size = bytes.byteLength
        return bytes
      })
      return slice(await this.#whole, offset, length)
    }
    const cr = CONTENT_RANGE.exec(res.headers.get('content-range') ?? '')
    if (cr && cr[3] !== '*') this.#size = Number(cr[3])
    return new Uint8Array(await res.arrayBuffer())
  }
}

const slice = (b: Uint8Array, offset: number, length: number): Uint8Array =>
  b.subarray(Math.min(offset, b.byteLength), Math.min(offset + length, b.byteLength))

/** A byte range [start, end). */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Merge byte ranges whose gap is at most `maxGap` so interleaved audio/video chunks are
 * fetched with a few large requests instead of many tiny ones. Input need not be sorted.
 */
export function coalesceRanges(ranges: readonly ByteRange[], maxGap: number): ByteRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: ByteRange[] = [{ ...sorted[0]! }]
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!
    const last = out[out.length - 1]!
    if (r.start - last.end <= maxGap) {
      if (r.end > last.end) last.end = r.end
    } else {
      out.push({ ...r })
    }
  }
  return out
}
