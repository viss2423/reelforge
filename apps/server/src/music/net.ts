/**
 * Polite HTTP for the music sources: per-source request spacing (well under each API's
 * published limits), a cooldown after 429/503 honouring Retry-After, timeouts, an honest
 * User-Agent and only public https URLs (track URLs come from third-party API responses).
 */
import { isIP } from 'node:net'

export type FetchLike = typeof fetch

export const USER_AGENT =
  'ReelForge/0.1 (+https://github.com/viss2423/reelforge; self-hosted editor)'

export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceUnavailableError'
  }
}

/** Rejects anything but https URLs to public host names (no IP literals, no localhost). */
export const assertPublicHttps = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid URL: ${raw.slice(0, 100)}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    url.protocol !== 'https:' ||
    isIP(host) !== 0 ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.')
  )
    throw new Error(`refusing to fetch ${url.protocol}//${host}`)
  return url
}

/** Spacing + cooldown for one API. */
export class RateGate {
  readonly #minIntervalMs: number
  readonly #now: () => number
  #next = 0
  #coolUntil = 0

  constructor(minIntervalMs: number, now: () => number = Date.now) {
    this.#minIntervalMs = minIntervalMs
    this.#now = now
  }

  /** Milliseconds until the source may be called again after a 429 (0 = available). */
  get coolingMs(): number {
    return Math.max(0, this.#coolUntil - this.#now())
  }

  /** Waits for the next slot. Throws when cooling down (callers fall back to the cache). */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.coolingMs > 0)
      throw new SourceUnavailableError(`rate limited for ${Math.ceil(this.coolingMs / 1000)} s`)
    const now = this.#now()
    const at = Math.max(now, this.#next)
    this.#next = at + this.#minIntervalMs
    const wait = at - now
    if (wait > 0) await abortableDelay(wait, signal)
  }

  coolDown(ms: number): void {
    this.#coolUntil = Math.max(this.#coolUntil, this.#now() + ms)
  }
}

const abortableDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const retryAfterMs = (res: Response): number => {
  const h = res.headers.get('retry-after')
  const s = h ? Number(h) : NaN
  return Number.isFinite(s) && s > 0 ? Math.min(s, 24 * 3600) * 1000 : 60_000
}

/** GET JSON through a rate gate. */
export const getJson = async (
  fetchImpl: FetchLike,
  gate: RateGate,
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<unknown> => {
  assertPublicHttps(url)
  await gate.acquire(opts.signal)
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...opts.headers },
      signal,
      redirect: 'follow',
    })
  } catch (err) {
    if (opts.signal?.aborted) throw err
    throw new SourceUnavailableError(
      timeout.aborted
        ? 'timed out'
        : `offline (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (res.status === 429 || res.status === 503) {
    gate.coolDown(retryAfterMs(res))
    throw new SourceUnavailableError(`rate limited (HTTP ${res.status})`)
  }
  if (!res.ok) throw new SourceUnavailableError(`HTTP ${res.status}`)
  return res.json()
}
