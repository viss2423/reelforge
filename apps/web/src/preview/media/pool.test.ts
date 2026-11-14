import { describe, expect, it, vi } from 'vitest'
import { image, sticker, video } from '../test/model.ts'
import type { VisualClip } from '../timeline/resolve.ts'
import { planPool, poolKey, POOL_GRACE_MS, SourcePool, type PoolEntryState } from './pool.ts'
import type { PixelSource } from './source.ts'

const st = (video: boolean, lastWanted: number): PoolEntryState => ({ video, lastWanted })

describe('planPool', () => {
  it('opens wanted sources up to the video cap; images are uncapped', () => {
    const plan = planPool(
      [
        { key: 'v1', video: true },
        { key: 'i1', video: false },
        { key: 'v2', video: true },
        { key: 'v3', video: true },
      ],
      new Map(),
      2,
      0,
    )
    expect(plan.open).toEqual(['v1', 'i1', 'v2'])
    expect(plan.close).toEqual([])
  })

  it('keeps idle sources for the grace period, then closes them', () => {
    const open = new Map([['old', st(false, 1000)]])
    expect(planPool([], open, 4, 1000 + POOL_GRACE_MS - 1).close).toEqual([])
    expect(planPool([], open, 4, 1000 + POOL_GRACE_MS).close).toEqual(['old'])
  })

  it('evicts the least recently wanted idle video when a wanted video needs the slot', () => {
    const open = new Map([
      ['a', st(true, 10)],
      ['b', st(true, 5)],
    ])
    const plan = planPool([{ key: 'c', video: true }], open, 2, 20)
    expect(plan.close).toEqual(['b'])
    expect(plan.open).toEqual(['c'])
  })

  it('never evicts a source that is still wanted', () => {
    const open = new Map([['a', st(true, 0)]])
    const plan = planPool([{ key: 'a', video: true }], open, 1, 10_000)
    expect(plan).toEqual({ open: [], close: [] })
  })
})

describe('poolKey', () => {
  it('distinguishes clips and media, and is stable per clip object', () => {
    const v = video({ id: 'x', assetId: 'a1' })
    expect(poolKey(v)).toBe('x|a1')
    expect(poolKey(v)).toBe(poolKey(v))
    expect(poolKey(video({ id: 'x', assetId: 'a2' }))).toBe('x|a2')
    expect(poolKey(sticker({ id: 's', ref: 'pack/star' }))).toBe('s|pack/star')
    expect(poolKey(sticker({ id: 's', assetId: 'img' }))).toBe('s|img')
  })
})

class FakeSource implements PixelSource {
  readonly kind = 'webcodecs'
  info = undefined
  error: Error | undefined = undefined
  closed = false
  want(): void {}
  frame(): null {
    return null
  }
  close(): void {
    this.closed = true
  }
}

describe('SourcePool', () => {
  const setup = (cap = 2) => {
    const made: FakeSource[] = []
    const factory = vi.fn<(clip: VisualClip, prev: PixelSource | undefined) => PixelSource | null>(
      (_clip, prev) => {
        if (prev) return null // no fallback available
        const s = new FakeSource()
        made.push(s)
        return s
      },
    )
    return { pool: new SourcePool(factory, cap), made, factory }
  }

  it('opens one source per clip and reuses it across frames', () => {
    const { pool, factory } = setup()
    const a = video()
    const b = image()
    for (let f = 0; f < 5; f++) pool.update([a, b], 2, f * 16)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(pool.size).toBe(2)
    expect(pool.get(a)).toBeDefined()
  })

  it('caps concurrent video decoders and opens deferred clips when slots free up', () => {
    const { pool } = setup(1)
    const a = video()
    const b = video()
    pool.update([a, b], 2, 0)
    expect(pool.get(a)).toBeDefined()
    expect(pool.get(b)).toBeUndefined()
    // a is no longer needed: b takes its slot immediately (pressure), no grace wait
    pool.update([b], 1, 16)
    expect(pool.get(a)).toBeUndefined()
    expect(pool.get(b)).toBeDefined()
  })

  it('drops failed sources and does not retry them every frame', () => {
    const { pool, made, factory } = setup()
    const a = video()
    pool.update([a], 1, 0)
    made[0]!.error = new Error('codec unsupported')
    pool.update([a], 1, 16)
    expect(made[0]!.closed).toBe(true)
    expect(pool.get(a)).toBeUndefined()
    pool.update([a], 1, 32)
    expect(factory).toHaveBeenCalledTimes(2) // open + fallback attempt, nothing more
    expect(pool.failedCount).toBe(1)
  })

  it('ignores duplicate clips in the wanted list', () => {
    const { pool, factory } = setup()
    const a = video()
    pool.update([a, a, a], 3, 0)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('closeAll releases every source', () => {
    const { pool, made } = setup()
    pool.update([video(), video()], 2, 0)
    pool.closeAll()
    expect(made.every((s) => s.closed)).toBe(true)
    expect(pool.size).toBe(0)
  })
})
