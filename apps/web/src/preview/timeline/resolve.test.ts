import { describe, expect, it } from 'vitest'
import { image, mainTrack, project, sticker, track, video } from '../test/model.ts'
import { effectiveOverlap } from '@reelforge/core'
import { mainClipIndexAt, mainTrackLayout } from './layout.ts'
import { createFramePlan, TimelineIndex, type Slot } from './resolve.ts'

const S = 1_000_000
const ids = (...c: Array<{ id: string }>): string[] => c.map((x) => x.id)

describe('mainTrackLayout', () => {
  it('lays out contiguous clips without transitions', () => {
    const L = mainTrackLayout(mainTrack([video({ duration: 2 * S }), video({ duration: 3 * S })]))
    expect([...L.starts]).toEqual([0, 2 * S])
    expect([...L.ends]).toEqual([2 * S, 5 * S])
    expect(L.total).toBe(5 * S)
  })

  it('overlaps transitions: total = Σ durations − Σ transitions', () => {
    const L = mainTrackLayout(
      mainTrack([
        video({ duration: 2 * S }),
        video({ duration: 3 * S, transitionIn: { type: 'fade', duration: 500_000 } }),
        image({ duration: 2 * S, transitionIn: { type: 'wipeleft', duration: 400_000 } }),
      ]),
    )
    expect([...L.starts]).toEqual([0, 1_500_000, 4_100_000])
    expect(L.total).toBe(7 * S - 900_000)
    expect([...L.transIn]).toEqual([0, 500_000, 400_000])
    expect(L.transType).toEqual([null, 'fade', 'wipeleft'])
  })

  it('ignores a transition on the first clip and clamps to half of either clip', () => {
    const a = video({ duration: 600_000, transitionIn: { type: 'fade', duration: 400_000 } })
    const b = video({ duration: 3 * S, transitionIn: { type: 'fade', duration: 1_000_000 } })
    const L = mainTrackLayout(mainTrack([a, b]))
    expect(L.transIn[0]).toBe(0)
    expect(effectiveOverlap(b.transitionIn, a.duration, b.duration)).toBe(300_000)
    expect(L.starts[1]).toBe(300_000)
  })

  it('turns overlaps clamped below the minimum into hard cuts (like core)', () => {
    const a = video({ duration: 80_000 })
    const b = video({ duration: S, transitionIn: { type: 'fade', duration: 400_000 } })
    const L = mainTrackLayout(mainTrack([a, b]))
    expect(L.transIn[1]).toBe(0)
    expect(L.transType[1]).toBeNull()
    expect(L.starts[1]).toBe(80_000)
  })

  it('handles empty / missing main tracks', () => {
    expect(mainTrackLayout(undefined).total).toBe(0)
    const L = mainTrackLayout(mainTrack([]))
    expect(mainClipIndexAt(L, 0)).toBe(-1)
  })

  it('mainClipIndexAt binary search at boundaries', () => {
    const L = mainTrackLayout(
      mainTrack([video({ duration: S }), video({ duration: S }), video({ duration: S })]),
    )
    expect(mainClipIndexAt(L, -1)).toBe(-1)
    expect(mainClipIndexAt(L, 0)).toBe(0)
    expect(mainClipIndexAt(L, S - 1)).toBe(0)
    expect(mainClipIndexAt(L, S)).toBe(1)
    expect(mainClipIndexAt(L, 3 * S + 5)).toBe(2)
  })
})

describe('TimelineIndex.resolve', () => {
  const a = video({ duration: 2 * S })
  const b = video({ duration: 2 * S, transitionIn: { type: 'circleopen', duration: 500_000 } })
  const pip = video({ start: 500_000, duration: S })
  const st = sticker({ start: 2 * S, duration: S })
  const p = project([
    mainTrack([a, b]),
    track('overlay', [st, pip]), // unsorted on purpose
    track('text', []),
  ])
  const idx = new TimelineIndex(p)
  const plan = createFramePlan()

  it('computes duration across tracks', () => {
    expect(idx.duration).toBe(3_500_000)
  })

  it('single main clip + overlay', () => {
    idx.resolve(1_000_000, plan)
    expect(plan.mainA.clip?.id).toBe(a.id)
    expect(plan.mainA.local).toBe(1_000_000)
    expect(plan.mainB.clip).toBeNull()
    expect(plan.transition).toBeNull()
    expect(plan.overlayCount).toBe(1)
    expect(plan.overlays[0]!.clip?.id).toBe(pip.id)
    expect(plan.overlays[0]!.local).toBe(500_000)
    expect(plan.overlaysBelowMain).toBe(0)
  })

  it('transition window: both clips with forward progress', () => {
    idx.resolve(1_500_000 + 125_000, plan)
    expect(plan.mainA.clip?.id).toBe(a.id)
    expect(plan.mainB.clip?.id).toBe(b.id)
    expect(plan.transition).toBe('circleopen')
    expect(plan.progress).toBeCloseTo(0.25, 10)
    expect(plan.mainA.local).toBe(1_625_000)
    expect(plan.mainB.local).toBe(125_000)
    expect(plan.overlayCount).toBe(0)
  })

  it('after the transition only the incoming clip remains', () => {
    idx.resolve(2_000_000, plan)
    expect(plan.mainA.clip?.id).toBe(b.id)
    expect(plan.mainA.local).toBe(500_000)
    expect(plan.transition).toBeNull()
    expect(plan.overlays[0]!.clip?.id).toBe(st.id)
  })

  it('past the end nothing is visible', () => {
    idx.resolve(10 * S, plan)
    expect(plan.mainA.clip).toBeNull()
    expect(plan.overlayCount).toBe(0)
  })

  it('does not allocate per call once warm', () => {
    const overlays = plan.overlays
    const slot = plan.mainA
    for (let t = 0; t < 3 * S; t += 33_333) idx.resolve(t, plan)
    expect(plan.overlays).toBe(overlays)
    expect(plan.mainA).toBe(slot)
  })

  it('collect() returns visible + upcoming media for pre-roll', () => {
    const out: Slot[] = []
    let n = idx.collect(0, 600_000, out)
    expect(out.slice(0, n).map((s) => s.clip?.id)).toEqual(ids(a, pip))
    // during the transition both main clips are collected
    n = idx.collect(1_600_000, 0, out)
    expect(out.slice(0, n).map((s) => s.clip?.id)).toEqual(ids(a, b))
    n = idx.collect(1_600_000, 500_000, out)
    expect(out.slice(0, n).map((s) => s.clip?.id)).toEqual(ids(a, b, st))
  })

  it('hidden tracks are skipped; overlays below main are counted', () => {
    const under = video({ start: 0, duration: S })
    const q = project([
      track('overlay', [under]),
      mainTrack([video({ duration: S })], { hidden: true }),
      track('overlay', [video({ duration: S })], { hidden: true }),
    ])
    const i2 = new TimelineIndex(q)
    i2.resolve(0, plan)
    expect(plan.mainA.clip).toBeNull()
    expect(plan.overlayCount).toBe(1)
    expect(plan.overlays[0]!.clip?.id).toBe(under.id)
    expect(plan.overlaysBelowMain).toBe(1)
  })

  it('duration includes caption words', () => {
    const q = project([mainTrack([video({ duration: S })])], {
      captions: {
        words: [{ text: 'hi', start: 0, end: 2 * S }],
        style: { base: {} },
      },
    })
    expect(new TimelineIndex(q).duration).toBe(2 * S)
  })
})
