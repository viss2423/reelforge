import { sec } from '@reelforge/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FLING_TIME_CONSTANT,
  VelocityTracker,
  flingDistance,
  flingStep,
} from '@/editor/timeline/inertia.ts'
import {
  decodeWaveform,
  drawWaveform,
  filmstrip,
  levelFor,
  setMediaLoader,
  sourceAt,
  useThumbsIndex,
  useWaveform,
  waveLevel,
  type MediaLoader,
  type ThumbsIndex,
} from '@/editor/timeline/media.ts'
import { clip } from './helpers.ts'

describe('inertia', () => {
  it('measures velocity over the recent window only', () => {
    const v = new VelocityTracker()
    v.add(0, 0, 0)
    v.add(10, 20, 5)
    v.add(20, 40, 10)
    expect(v.velocity(20)).toEqual({ vx: 2, vy: 0.5 })
    // The pointer rested for longer than the window: no fling.
    expect(v.velocity(500)).toEqual({ vx: 0, vy: 0 })
    v.reset()
    expect(v.velocity(20)).toEqual({ vx: 0, vy: 0 })
  })

  it('caps wild swipes', () => {
    const v = new VelocityTracker()
    v.add(0, 0, 0)
    v.add(1, 1000, -1000)
    expect(v.velocity(1)).toEqual({ vx: 8, vy: -8 })
  })

  it('fling steps are frame-rate independent and sum to v × τ', () => {
    let a = { dx: 0, v: 1 }
    let totalA = 0
    for (let i = 0; i < 600; i++) {
      a = flingStep(a.v, 1000 / 60)
      totalA += a.dx
    }
    let b = { dx: 0, v: 1 }
    let totalB = 0
    for (let i = 0; i < 1200; i++) {
      b = flingStep(b.v, 1000 / 120)
      totalB += b.dx
    }
    expect(totalA).toBeCloseTo(totalB, 6)
    expect(totalA).toBeCloseTo(flingDistance(1), 3)
    expect(flingDistance(2)).toBe(2 * FLING_TIME_CONSTANT)
  })
})

describe('waveform', () => {
  const data = { bucketUs: 10_000, count: 4, peaks: [-10, 20, -50, 5, -3, 3, -1, 90] }

  it('builds min/max mip levels lazily', () => {
    const w = decodeWaveform(data)
    expect(w.levels).toHaveLength(1)
    expect([...waveLevel(w, 1)]).toEqual([-50, 20, -3, 90])
    expect([...waveLevel(w, 2)]).toEqual([-50, 90])
    expect(w.levels).toHaveLength(3)
    // Odd bucket counts carry the last bucket through.
    const odd = decodeWaveform({ bucketUs: 1, count: 3, peaks: [-1, 1, -2, 2, -9, 9] })
    expect([...waveLevel(odd, 1)]).toEqual([-2, 2, -9, 9])
  })

  it('levelFor picks the coarsest level not exceeding one column', () => {
    expect(levelFor(10_000, 5_000)).toBe(0)
    expect(levelFor(10_000, 10_000)).toBe(0)
    expect(levelFor(10_000, 25_000)).toBe(1)
    expect(levelFor(10_000, 80_000)).toBe(3)
  })

  it('draws one bar per device column using the matching level', () => {
    const fillRect = vi.fn<CanvasRenderingContext2D['fillRect']>()
    const ctx = {
      clearRect: vi.fn<CanvasRenderingContext2D['clearRect']>(),
      fillRect,
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D
    const w = decodeWaveform({
      bucketUs: 10_000,
      count: 100,
      peaks: Array.from({ length: 200 }, (_, i) => (i % 2 ? 64 : -64)),
    })
    drawWaveform(ctx, w, {
      width: 50,
      height: 20,
      dpr: 2,
      sourceStart: 0,
      usPerPx: 10_000,
      color: 'white',
    })
    expect(fillRect).toHaveBeenCalledTimes(100)
    const [, y, , h] = fillRect.mock.calls[0] as number[]
    expect(y! + h! / 2).toBeCloseTo(20) // centred in the 40 px tall device canvas
    expect(h).toBeGreaterThan(15)
    // Columns past the end of the data are skipped.
    fillRect.mockClear()
    drawWaveform(ctx, w, {
      width: 50,
      height: 20,
      dpr: 1,
      sourceStart: sec(0.9),
      usPerPx: 10_000,
      color: 'w',
    })
    expect(fillRect).toHaveBeenCalledTimes(10)
  })
})

describe('source mapping and filmstrip', () => {
  it('sourceAt follows in-point, speed and reverse', () => {
    expect(sourceAt(clip('video', 0, sec(4), { in: sec(1) }), sec(1))).toBe(sec(2))
    expect(sourceAt(clip('video', 0, sec(2), { in: sec(1), speed: 2 }), sec(1))).toBe(sec(3))
    expect(sourceAt(clip('video', 0, sec(4), { in: sec(1), reverse: true }), sec(1))).toBe(sec(4))
    expect(sourceAt(clip('image', 0, sec(4)), sec(1))).toBe(0)
  })

  const index: ThumbsIndex = {
    interval: sec(1),
    columns: 10,
    rows: 2,
    tileWidth: 90,
    tileHeight: 160,
    count: 20,
  }

  it('produces only the visible slots with sprite offsets', () => {
    const c = clip('video', 0, sec(10))
    const ppu = 100 / 1e6 // 100 px/s → clip is 1000 px wide
    // Row 56 px: tile scaled to 31.5 px wide.
    const strip = filmstrip(index, c, ppu, 1000, 56, 300, 400)
    expect(strip.slotWidth).toBeCloseTo(31.5)
    expect(strip.bgWidth).toBeCloseTo(315)
    expect(strip.bgHeight).toBe(112)
    expect(strip.slots.length).toBeLessThanOrEqual(5)
    for (const s of strip.slots) {
      expect(s.x + strip.slotWidth).toBeGreaterThan(300)
      expect(s.x).toBeLessThan(400)
    }
    // A slot near 3.3 s shows tile 3.
    const slot = strip.slots.find((s) => s.x <= 330 && s.x + strip.slotWidth > 330)!
    expect(slot.bgX).toBeCloseTo(-3 * strip.slotWidth)
    expect(slot.bgY).toBe(-0)
  })

  it('clamps tiles to the sprite and wraps rows', () => {
    const c = clip('video', 0, sec(30), { in: sec(12) })
    const strip = filmstrip(index, c, 100 / 1e6, 3000, 56, 0, 40)
    expect(strip.slots[0]!.bgY).toBe(-56) // tile 12 → row 1
    const late = filmstrip(index, c, 100 / 1e6, 3000, 56, 2900, 3000)
    const last = late.slots.at(-1)!
    expect(last.bgX).toBeCloseTo(-9 * late.slotWidth) // tile 19 (clamped)
  })
})

describe('media resources', () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  it('fetches each asset once, shares it, and stays null when not ready', async () => {
    const thumbs = vi.fn<MediaLoader['thumbs']>(async () => ({
      interval: sec(1),
      columns: 1,
      rows: 1,
      tileWidth: 9,
      tileHeight: 16,
      count: 1,
    }))
    const waveform = vi.fn<MediaLoader['waveform']>(async () => ({
      bucketUs: 1000,
      count: 1,
      peaks: [-1, 1],
    }))
    restore = setMediaLoader({ thumbs, waveform })
    const a = renderHook(() => useThumbsIndex('a1', true))
    const b = renderHook(() => useThumbsIndex('a1', true))
    const none = renderHook(() => useThumbsIndex('a1', false))
    await waitFor(() => expect(a.result.current?.count).toBe(1))
    expect(b.result.current).toBe(a.result.current)
    expect(none.result.current).toBeNull()
    expect(thumbs).toHaveBeenCalledTimes(1)

    const w = renderHook(() => useWaveform('a1', true))
    await waitFor(() => expect(w.result.current?.levels[0]).toEqual(Int8Array.from([-1, 1])))
  })

  it('drops failed loads so a later mount retries', async () => {
    let fail = true
    const thumbs = vi.fn<MediaLoader['thumbs']>(async () => {
      if (fail) throw new Error('404')
      return { interval: 1, columns: 1, rows: 1, tileWidth: 1, tileHeight: 1, count: 1 }
    })
    restore = setMediaLoader({ thumbs, waveform: vi.fn<MediaLoader['waveform']>() })
    const first = renderHook(() => useThumbsIndex('x', true))
    await act(async () => {
      await Promise.resolve()
    })
    expect(first.result.current).toBeNull()
    first.unmount()
    fail = false
    const second = renderHook(() => useThumbsIndex('x', true))
    await waitFor(() => expect(second.result.current).not.toBeNull())
    expect(thumbs).toHaveBeenCalledTimes(2)
  })
})
