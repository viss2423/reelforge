/**
 * Pixel-source pool: one source per visible-or-upcoming clip, with a hard cap on concurrent
 * VIDEO decoders (phones run out of hardware decoder instances / memory long before CPU) and
 * a short grace period so scrubbing back and forth across a cut does not thrash decoders.
 *
 * Sources are keyed per CLIP (not per asset): two adjacent pieces of the same file need two
 * decoders during a transition, and pre-rolling the next clip at its in-point must not
 * disturb the decoder showing the current one.
 */
import type { VisualClip } from '../timeline/resolve.ts'
import type { PixelSource } from './source.ts'

/** Grace (ms) before an unneeded source is closed when the cap is not under pressure. */
export const POOL_GRACE_MS = 1500

export interface PoolWant {
  key: string
  video: boolean
}

export interface PoolEntryState {
  video: boolean
  /** performance.now() when last wanted. */
  lastWanted: number
}

export interface PoolPlan {
  open: string[]
  close: string[]
}

/**
 * Decide which sources to open and close. `wants` is in priority order (visible now first,
 * then by start time). At most `cap` video sources stay open: wanted ones beyond the cap are
 * deferred; unwanted ones are closed after `grace` ms, or immediately when a wanted video
 * source needs the slot.
 */
export function planPool(
  wants: readonly PoolWant[],
  open: ReadonlyMap<string, PoolEntryState>,
  cap: number,
  now: number,
  grace = POOL_GRACE_MS,
): PoolPlan {
  const desired = new Set<string>()
  let videos = 0
  for (const w of wants) {
    if (w.video) {
      if (videos >= cap) continue
      videos++
    }
    desired.add(w.key)
  }
  const close: string[] = []
  // unwanted, oldest first: these are the eviction candidates
  const idle = [...open]
    .filter(([k]) => !desired.has(k))
    .sort((a, b) => a[1].lastWanted - b[1].lastWanted)
  let openVideos = 0
  for (const [, s] of open) if (s.video) openVideos++
  const missingVideos = [...desired].filter(
    (k) => !open.has(k) && wants.some((w) => w.key === k && w.video),
  ).length
  let pressure = Math.max(0, openVideos + missingVideos - cap)
  for (const [k, s] of idle) {
    if (s.video && pressure > 0) {
      close.push(k)
      pressure--
    } else if (now - s.lastWanted >= grace) {
      close.push(k)
    }
  }
  const openList: string[] = []
  for (const k of desired) if (!open.has(k)) openList.push(k)
  return { open: openList, close }
}

const keys = new WeakMap<VisualClip, string>()

/**
 * Pool key of a clip: changes when the clip's media changes. Memoised per clip object (the
 * model is immutable — Immer produces a new object for every change), so the per-frame
 * lookups allocate nothing.
 */
export function poolKey(c: VisualClip): string {
  let k = keys.get(c)
  if (k === undefined) {
    k = c.type === 'sticker' ? `${c.id}|${c.assetId ?? c.ref ?? ''}` : `${c.id}|${c.assetId}`
    keys.set(c, k)
  }
  return k
}

interface Entry extends PoolEntryState {
  source: PixelSource
}

export type SourceFactory = (
  clip: VisualClip,
  previous: PixelSource | undefined,
) => PixelSource | null

export class SourcePool {
  readonly #entries = new Map<string, Entry>()
  readonly #factory: SourceFactory
  cap: number
  // scratch reused every update (no per-frame allocation in steady state)
  readonly #wants: PoolWant[] = []
  readonly #wantObjs: PoolWant[] = []
  readonly #clips = new Map<string, VisualClip>()
  /**
   * Keys whose sources (and fallbacks) failed: not retried every frame, only when the clip
   * changes or `retryFailed()` says the inputs did (e.g. the asset list arrived).
   */
  readonly #failed = new Set<string>()

  constructor(factory: SourceFactory, cap: number) {
    this.#factory = factory
    this.cap = cap
  }

  /** Sync the pool with the clips needed now and soon (priority order). */
  update(clips: readonly VisualClip[], count: number, now: number): void {
    const wants = this.#wants
    this.#clips.clear()
    let n = 0
    let allOpen = true
    for (let i = 0; i < count; i++) {
      const c = clips[i]!
      const key = poolKey(c)
      if (this.#clips.has(key) || this.#failed.has(key)) continue
      this.#clips.set(key, c)
      let w = this.#wantObjs[n]
      if (!w) {
        w = { key, video: false }
        this.#wantObjs.push(w)
      }
      w.key = key
      w.video = c.type === 'video'
      wants[n++] = w
      const e = this.#entries.get(key)
      if (e) e.lastWanted = now
      else allOpen = false
    }
    wants.length = n
    // fast path: everything wanted is open and nothing is idle
    if (allOpen && n === this.#entries.size) {
      this.#replaceFailed()
      return
    }
    const plan = planPool(wants, this.#entries, this.cap, now)
    for (const k of plan.close) {
      this.#entries.get(k)?.source.close()
      this.#entries.delete(k)
    }
    for (const k of plan.open) {
      const clip = this.#clips.get(k)!
      const source = this.#factory(clip, undefined)
      if (source) this.#entries.set(k, { source, video: clip.type === 'video', lastWanted: now })
      else this.#failed.add(k)
    }
    this.#replaceFailed()
  }

  /** Give the factory a chance to substitute a fallback for sources that failed. */
  #replaceFailed(): void {
    for (const [k, e] of this.#entries) {
      if (!e.source.error) continue
      const clip = this.#clips.get(k)
      if (!clip) continue
      const next = this.#factory(clip, e.source)
      e.source.close()
      if (next && next !== e.source) e.source = next
      else {
        this.#entries.delete(k)
        this.#failed.add(k)
      }
    }
  }

  get(clip: VisualClip): PixelSource | undefined {
    return this.#entries.get(poolKey(clip))?.source
  }

  get size(): number {
    return this.#entries.size
  }

  /** Errors of sources that could not be opened at all (for the stats overlay). */
  get failedCount(): number {
    return this.#failed.size
  }

  /**
   * Forget past failures so the next update tries those clips again. Call when what a source
   * is opened from changed: a clip whose asset wasn't loaded yet has no URL and fails, and
   * would otherwise stay blank after the assets arrive.
   */
  retryFailed(): void {
    this.#failed.clear()
  }

  closeAll(): void {
    for (const e of this.#entries.values()) e.source.close()
    this.#entries.clear()
  }
}
