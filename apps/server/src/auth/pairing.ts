/**
 * Device pairing with a rotating 6-digit code.
 *
 * - The code comes from `crypto.randomInt` and rotates every 5 minutes, and immediately
 *   after a device paired with it (single use).
 * - Comparison is constant-time.
 * - Brute force is bounded twice: per client address (a few failures per window) and
 *   globally (too many failures from anywhere rotates the code), so even a distributed
 *   attacker gets a handful of guesses out of 1 000 000 per code.
 */
import { randomInt, timingSafeEqual } from 'node:crypto'

export const CODE_TTL_MS = 5 * 60_000
export const CODE_DIGITS = 6

/** Sliding-window failure counter keyed by client address. */
export class RateLimiter {
  readonly #max: number
  readonly #windowMs: number
  readonly #now: () => number
  readonly #hits = new Map<string, number[]>()

  constructor(opts: { max: number; windowMs: number; now?: () => number }) {
    this.#max = opts.max
    this.#windowMs = opts.windowMs
    this.#now = opts.now ?? Date.now
  }

  #recent(key: string): number[] {
    const cutoff = this.#now() - this.#windowMs
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > cutoff)
    if (hits.length === 0) this.#hits.delete(key)
    else this.#hits.set(key, hits)
    return hits
  }

  /** Milliseconds until `key` may try again (0 = allowed now). */
  retryAfter(key: string): number {
    const hits = this.#recent(key)
    if (hits.length < this.#max) return 0
    return Math.max(1, hits[hits.length - this.#max]! + this.#windowMs - this.#now())
  }

  hit(key: string): void {
    const hits = this.#recent(key)
    hits.push(this.#now())
    this.#hits.set(key, hits)
    // Bound memory under a flood of distinct addresses.
    if (this.#hits.size > 10_000) this.#prune()
  }

  reset(key: string): void {
    this.#hits.delete(key)
  }

  #prune(): void {
    // Deleting the current key while iterating a Map is well-defined.
    for (const key of this.#hits.keys()) this.#recent(key)
  }
}

export class PairingRateLimitedError extends Error {
  readonly retryAfterMs: number
  constructor(retryAfterMs: number) {
    super('too many pairing attempts; try again later')
    this.retryAfterMs = retryAfterMs
  }
}

export interface PairingOptions {
  now?: () => number
  ttlMs?: number
  /** Failed attempts per client address per window. */
  maxFailuresPerClient?: number
  /** Failed attempts across all clients before the code is rotated. */
  maxFailuresPerCode?: number
  windowMs?: number
  /**
   * Test-only fixed code accepted any number of times next to the rotating one (end-to-end
   * runs pair several browsers without reading the code). Failures are still rate limited.
   */
  fixedCode?: string | undefined
}

/** The rotating pairing code. */
export class PairingCodes {
  readonly #now: () => number
  readonly #ttl: number
  readonly #limiter: RateLimiter
  readonly #maxPerCode: number
  readonly #fixed: Buffer | undefined
  #code = ''
  #expiresAt = 0
  #failures = 0

  constructor(opts: PairingOptions = {}) {
    this.#now = opts.now ?? Date.now
    this.#ttl = opts.ttlMs ?? CODE_TTL_MS
    this.#maxPerCode = opts.maxFailuresPerCode ?? 20
    this.#fixed = opts.fixedCode ? Buffer.from(opts.fixedCode) : undefined
    this.#limiter = new RateLimiter({
      max: opts.maxFailuresPerClient ?? 5,
      windowMs: opts.windowMs ?? CODE_TTL_MS,
      now: this.#now,
    })
  }

  /** Current code (rotated lazily when expired). */
  current(): { code: string; expiresAt: number } {
    if (this.#now() >= this.#expiresAt) this.rotate()
    return { code: this.#code, expiresAt: this.#expiresAt }
  }

  /** Replaces the code with a fresh random one. */
  rotate(): void {
    this.#code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')
    this.#expiresAt = this.#now() + this.#ttl
    this.#failures = 0
  }

  /**
   * Checks `candidate` for `client`. A correct code is consumed (rotated) so it pairs exactly
   * one device. Throws PairingRateLimitedError while the client is locked out.
   */
  consume(candidate: string, client: string): boolean {
    const wait = this.#limiter.retryAfter(client)
    if (wait > 0) throw new PairingRateLimitedError(wait)
    const { code } = this.current()
    const a = Buffer.from(code)
    const b = Buffer.from(candidate.padEnd(code.length, '\0').slice(0, 32))
    // timingSafeEqual needs equal lengths; the length check leaks nothing (always 6 digits).
    const ok = a.length === b.length && timingSafeEqual(a, b)
    if (ok) {
      this.#limiter.reset(client)
      this.rotate()
      return true
    }
    if (this.#fixed?.length === b.length && timingSafeEqual(this.#fixed, b)) {
      this.#limiter.reset(client)
      return true
    }
    this.#limiter.hit(client)
    if (++this.#failures >= this.#maxPerCode) this.rotate()
    return false
  }
}
