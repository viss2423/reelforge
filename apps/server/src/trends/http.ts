/**
 * Polite HTTP for trend sources: an honest User-Agent, a disk cache with TTL (a source is hit
 * at most once per TTL however often a refresh runs), conditional requests (ETag /
 * Last-Modified), a minimum gap between requests to the same host, and exponential backoff
 * that honours `Retry-After` on 429/5xx. A stale cached copy is returned when the network
 * fails, so one flaky source never empties the signals.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${new URL(url).host}`)
    this.status = status
  }
}

interface CacheEntry {
  url: string
  fetchedAt: number
  etag?: string
  lastModified?: string
  body: string
}

export interface PoliteHttpOptions {
  cacheDir: string
  userAgent: string
  fetch?: typeof fetch
  /** Minimum gap between two requests to the same host. */
  hostGapMs?: number
  retries?: number
  timeoutMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  clock?: () => number
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error)
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

/** `Retry-After` (seconds or HTTP date) → ms, capped. */
export const retryAfterMs = (
  value: string | null,
  now: number,
  cap = 60_000,
): number | undefined => {
  if (!value) return undefined
  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.min(cap, Math.max(0, secs * 1000))
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.min(cap, Math.max(0, at - now)) : undefined
}

export class PoliteHttp {
  readonly #o: Required<Omit<PoliteHttpOptions, 'fetch'>> & { fetch: typeof fetch }
  readonly #lastHit = new Map<string, number>()
  /** Requests made over the network (tests / stats). */
  requests = 0

  constructor(opts: PoliteHttpOptions) {
    this.#o = {
      fetch: opts.fetch ?? fetch,
      hostGapMs: 1_000,
      retries: 3,
      timeoutMs: 20_000,
      sleep: defaultSleep,
      clock: Date.now,
      ...opts,
    }
  }

  #cacheFile(url: string): string {
    return path.join(
      this.#o.cacheDir,
      `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`,
    )
  }

  async #readCache(url: string): Promise<CacheEntry | undefined> {
    try {
      const e = JSON.parse(await readFile(this.#cacheFile(url), 'utf8')) as CacheEntry
      return e.url === url ? e : undefined
    } catch {
      return undefined
    }
  }

  async #writeCache(entry: CacheEntry): Promise<void> {
    await mkdir(this.#o.cacheDir, { recursive: true })
    const file = this.#cacheFile(entry.url)
    await writeFile(`${file}.tmp`, JSON.stringify(entry))
    await rename(`${file}.tmp`, file)
  }

  async #spaceHost(url: string, signal: AbortSignal): Promise<void> {
    const host = new URL(url).host
    const last = this.#lastHit.get(host)
    const now = this.#o.clock()
    if (last !== undefined && now - last < this.#o.hostGapMs)
      await this.#o.sleep(this.#o.hostGapMs - (now - last), signal)
    this.#lastHit.set(host, this.#o.clock())
  }

  /**
   * GET `url` as text. Within `ttlMs` of the last successful fetch the cached body is returned
   * without any request. `cacheKey` lets callers keep secrets (API keys) out of cache files.
   */
  async get(
    url: string,
    opts: {
      signal: AbortSignal
      ttlMs?: number
      headers?: Record<string, string>
      cacheKey?: string
    },
  ): Promise<string> {
    const key = opts.cacheKey ?? url
    const cached = await this.#readCache(key)
    const now = this.#o.clock()
    if (cached && opts.ttlMs !== undefined && now - cached.fetchedAt < opts.ttlMs)
      return cached.body
    const headers: Record<string, string> = {
      'user-agent': this.#o.userAgent,
      accept: 'application/json, application/rss+xml, application/xml;q=0.9, */*;q=0.5',
      ...opts.headers,
    }
    if (cached?.etag) headers['if-none-match'] = cached.etag
    if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.#o.retries; attempt++) {
      opts.signal.throwIfAborted()
      await this.#spaceHost(url, opts.signal)
      let res: Response
      try {
        this.requests++
        res = await this.#o.fetch(url, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.any([opts.signal, AbortSignal.timeout(this.#o.timeoutMs)]),
        })
      } catch (err) {
        if (opts.signal.aborted) throw err
        lastErr = err
        await this.#o.sleep(1_000 * 2 ** attempt, opts.signal)
        continue
      }
      if (res.status === 304 && cached) {
        await res.body?.cancel()
        await this.#writeCache({ ...cached, fetchedAt: this.#o.clock() })
        return cached.body
      }
      if (res.ok) {
        const body = await res.text()
        const entry: CacheEntry = { url: key, fetchedAt: this.#o.clock(), body }
        const etag = res.headers.get('etag')
        const lm = res.headers.get('last-modified')
        if (etag) entry.etag = etag
        if (lm) entry.lastModified = lm
        await this.#writeCache(entry)
        return body
      }
      await res.body?.cancel()
      lastErr = new HttpError(res.status, url)
      // Client errors other than rate limiting will not fix themselves: stop now.
      if (res.status !== 429 && res.status < 500) break
      const wait =
        retryAfterMs(res.headers.get('retry-after'), this.#o.clock()) ?? 1_000 * 2 ** attempt
      if (attempt < this.#o.retries) await this.#o.sleep(wait, opts.signal)
    }
    if (cached) return cached.body
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}
