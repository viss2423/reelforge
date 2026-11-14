import { sec } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import {
  CONTENT_PAD,
  MARKER_ROW_HEIGHT,
  ROWS_PAD,
  ROW_GAP,
  TRACK_ROW_HEIGHT,
} from '@/editor/timeline/constants.ts'
import {
  computeWindow,
  contentEnd,
  firstTickIndex,
  layoutRows,
  lowerBound,
  mainSpans,
  maxScrollX,
  pxPerUs,
  rowAt,
  tickLabel,
  tickSpec,
  tickTime,
  timeToX,
  trackSpans,
  upperBound,
  visibleRange,
  windowCovers,
  xToTime,
  zoomAnchoredScroll,
} from '@/editor/timeline/geometry.ts'
import { clip, mainClips, project, track } from './helpers.ts'

const fade = (ms: number) => ({ transitionIn: { type: 'fade', duration: ms * 1000 } })

describe('time ↔ px', () => {
  it('maps time 0 to the content pad and round-trips', () => {
    const ppu = pxPerUs(100)
    expect(timeToX(0, ppu)).toBe(CONTENT_PAD)
    expect(timeToX(sec(2), ppu)).toBe(CONTENT_PAD + 200)
    expect(xToTime(timeToX(1_234_567, ppu), ppu)).toBeCloseTo(1_234_567, 6)
  })
})

describe('mainSpans', () => {
  it('lays clips out contiguously without transitions', () => {
    const s = mainSpans(mainClips(1, 2, 3))
    expect([...s.starts]).toEqual([0, sec(1), sec(3)])
    expect([...s.ends]).toEqual([sec(1), sec(3), sec(6)])
    expect([...s.overlaps]).toEqual([0, 0, 0])
  })

  it('overlaps clips by their transition, clamped to half of both neighbours', () => {
    const clips = [
      clip('video', 0, sec(1), { id: 'a' }),
      clip('video', 0, sec(4), { id: 'b', ...fade(800) }), // clamped to 500 ms (half of a)
      clip('video', 0, sec(2), { id: 'c', ...fade(300) }),
    ]
    const s = mainSpans(clips)
    expect([...s.overlaps]).toEqual([0, 500_000, 300_000])
    expect([...s.starts]).toEqual([0, 500_000, 4_200_000])
    expect(s.ends[2]).toBe(6_200_000)
  })

  it('drops transitions on the first clip and below the core minimum', () => {
    const clips = [
      clip('video', 0, sec(2), { id: 'a', ...fade(400) }),
      clip('video', 0, 80_000, { id: 'b', ...fade(400) }), // half of b = 40 ms < 50 ms
    ]
    const s = mainSpans(clips)
    expect([...s.overlaps]).toEqual([0, 0])
    expect(s.starts[1]).toBe(sec(2))
  })

  it('caches spans per immutable clips array and track kind', () => {
    const clips = mainClips(1, 1)
    const a = trackSpans({ kind: 'main', clips })
    expect(trackSpans({ kind: 'main', clips })).toBe(a)
    // A free track uses clip.start directly.
    const free = trackSpans({ kind: 'overlay', clips: [clip('video', sec(5), sec(1))] })
    expect([...free.starts]).toEqual([sec(5)])
    expect([...free.ends]).toEqual([sec(6)])
  })
})

describe('binary search', () => {
  const arr = [1, 3, 3, 5]
  it('upperBound / lowerBound', () => {
    expect(upperBound(arr, 3)).toBe(3)
    expect(lowerBound(arr, 3)).toBe(1)
    expect(upperBound(arr, 0)).toBe(0)
    expect(lowerBound(arr, 9)).toBe(4)
    expect(upperBound([], 1)).toBe(0)
  })

  it('visibleRange returns clips intersecting [t0, t1)', () => {
    const s = mainSpans(mainClips(1, 1, 1, 1, 1))
    expect(visibleRange(s, sec(1.5), sec(3.2))).toEqual([1, 4])
    expect(visibleRange(s, sec(1), sec(2))).toEqual([1, 2]) // touching edges excluded
    expect(visibleRange(s, sec(10), sec(11))).toEqual([5, 5])
  })
})

describe('contentEnd', () => {
  it('is the max track end and marker time', () => {
    const p = project(
      [track('main', mainClips(2, 2)), track('text', [clip('text', sec(6), sec(1))], 'tx')],
      { markers: [{ id: 'mk', t: sec(3), kind: 'user' }] },
    )
    expect(contentEnd(p)).toBe(sec(7))
    expect(contentEnd(null)).toBe(0)
  })
})

describe('layoutRows', () => {
  const tracks = [
    track('main', [], 'main'),
    track('overlay', [], 'o1'),
    track('text', [], 't1'),
    track('audio', [], 'a1'),
    track('overlay', [], 'o2'),
  ]

  it('orders markers, captions, top-most visual tracks first, main, then audio', () => {
    const { rows } = layoutRows(tracks, true)
    expect(rows.map((r) => r.key)).toEqual(['markers', 'captions', 'o2', 't1', 'o1', 'main', 'a1'])
  })

  it('stacks rows with gaps and padding', () => {
    const { rows, height } = layoutRows([track('main', [])], false)
    expect(rows[0]).toMatchObject({ type: 'markers', y: ROWS_PAD })
    expect(rows[1]!.y).toBe(ROWS_PAD + MARKER_ROW_HEIGHT + ROW_GAP)
    expect(height).toBe(rows[1]!.y + TRACK_ROW_HEIGHT.main + ROWS_PAD)
  })

  it('rowAt finds rows, gaps resolve to -1 or the nearest row', () => {
    const { rows } = layoutRows([track('main', []), track('audio', [], 'a')], false)
    const main = rows[1]!
    expect(rowAt(rows, main.y + 1)).toBe(1)
    expect(rowAt(rows, main.y + main.height + 1)).toBe(-1) // in the gap
    expect(rowAt(rows, main.y + main.height + 1, true)).toBe(1)
    expect(rowAt(rows, 10_000, true)).toBe(2)
    expect(rowAt(rows, -50, true)).toBe(0)
  })
})

describe('render window', () => {
  const ppu = pxPerUs(100) // 100 px/s

  it('covers the viewport plus overscan, clamped at 0', () => {
    const w = computeWindow(0, 1000, ppu, 1)
    expect(w.start).toBe(0)
    expect(w.end).toBeCloseTo(xToTime(2000, ppu))
    const w2 = computeWindow(5000, 1000, ppu, 1)
    expect(w2.start).toBeCloseTo(xToTime(4000, ppu))
  })

  it('windowCovers stays true for small scrolls and false past half the overscan', () => {
    const w = computeWindow(5000, 1000, ppu, 1)
    expect(windowCovers(w, 5000, 1000, ppu, 1)).toBe(true)
    expect(windowCovers(w, 5400, 1000, ppu, 1)).toBe(true)
    expect(windowCovers(w, 5600, 1000, ppu, 1)).toBe(false)
    expect(windowCovers(w, 4400, 1000, ppu, 1)).toBe(false)
  })
})

describe('scroll maths', () => {
  it('maxScrollX leaves tail space and is never negative', () => {
    const ppu = pxPerUs(100)
    expect(maxScrollX(sec(100), ppu, 1000, 0.5)).toBe(CONTENT_PAD + 10_000 + 500 - 1000)
    expect(maxScrollX(sec(1), ppu, 1000, 0.5)).toBe(0)
  })

  it('zoomAnchoredScroll keeps the time under the anchor fixed', () => {
    const a = pxPerUs(100)
    const b = pxPerUs(250)
    const scroll = 1234
    const anchor = 300
    const t = xToTime(scroll + anchor, a)
    const next = zoomAnchoredScroll(scroll, anchor, a, b)
    expect(xToTime(next + anchor, b)).toBeCloseTo(t, 3)
  })
})

describe('ruler ticks', () => {
  it('uses frames when zoomed far in and labels them with frame numbers', () => {
    const spec = tickSpec(pxPerUs(2400), 30) // 80 px per frame
    expect(spec.inFrames).toBe(true)
    expect(spec.majorUs * pxPerUs(2400)).toBeGreaterThanOrEqual(72)
    const t = tickTime(spec, 4 * spec.majorEvery, 30)
    expect(tickLabel(t, spec, 30)).toMatch(/^\d+f$/)
    expect(tickLabel(0, spec, 30)).toBe('0:00')
  })

  it('uses whole seconds with subdivisions at normal zoom', () => {
    const spec = tickSpec(pxPerUs(120), 30)
    expect(spec.inFrames).toBe(false)
    expect(spec.majorUs).toBe(sec(1))
    expect(spec.majorEvery).toBeGreaterThan(1)
    expect((spec.unit * 120) / 1e6).toBeGreaterThanOrEqual(8)
    expect(tickLabel(sec(65), spec, 30)).toBe('1:05')
  })

  it('keeps labels at least the minimum apart at every zoom', () => {
    for (const zoom of [8, 13, 40, 77, 120, 300, 900, 2400]) {
      const ppu = pxPerUs(zoom)
      const spec = tickSpec(ppu, 30)
      expect(spec.majorUs * ppu).toBeGreaterThanOrEqual(72)
    }
  })

  it('firstTickIndex finds the first tick at or after t', () => {
    const spec = tickSpec(pxPerUs(120), 30)
    const i = firstTickIndex(spec, sec(3.3), 30)
    expect(tickTime(spec, i, 30)).toBeGreaterThanOrEqual(sec(3.3))
    expect(tickTime(spec, i - 1, 30)).toBeLessThan(sec(3.3))
    const fspec = tickSpec(pxPerUs(2400), 30)
    const j = firstTickIndex(fspec, sec(1) + 1, 30)
    expect(tickTime(fspec, j, 30)).toBeGreaterThan(sec(1))
  })

  it('labels half seconds with a decimal', () => {
    const spec = { unit: 100_000, inFrames: false, majorEvery: 5, majorUs: 500_000 }
    expect(tickLabel(1_500_000, spec, 30)).toBe('0:01.5')
  })
})
