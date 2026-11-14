import { sec } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import { SnapIndex, collectSnapTargets, snapTime } from '@/editor/timeline/snapping.ts'
import { clip, mainClips, project, track } from './helpers.ts'

describe('SnapIndex', () => {
  it('sorts, de-duplicates and keeps the highest-priority kind per time', () => {
    const idx = new SnapIndex([
      { t: 300, kind: 'clip' },
      { t: 100, kind: 'beat' },
      { t: 300, kind: 'playhead' },
      { t: Number.NaN, kind: 'playhead' },
      { t: 100, kind: 'clip' },
    ])
    expect([...idx.times]).toEqual([100, 300])
    expect(idx.kinds).toEqual(['beat', 'playhead'])
    expect(idx.size).toBe(2)
  })

  it('nearest respects the threshold and picks the closer neighbour', () => {
    const idx = new SnapIndex([
      { t: 1000, kind: 'clip' },
      { t: 2000, kind: 'clip' },
    ])
    expect(idx.nearest(1400, 500)?.t).toBe(1000)
    expect(idx.nearest(1600, 500)?.t).toBe(2000)
    expect(idx.nearest(1500, 400)).toBeNull()
    expect(idx.nearest(5000, 100)).toBeNull()
    expect(idx.nearest(0, 0)).toBeNull()
    expect(new SnapIndex([]).nearest(10, 100)).toBeNull()
  })

  it('breaks equal-distance ties by priority', () => {
    const idx = new SnapIndex([
      { t: 1000, kind: 'clip' },
      { t: 2000, kind: 'playhead' },
    ])
    expect(idx.nearest(1500, 600)).toEqual({ t: 2000, kind: 'playhead' })
  })

  it('snapEdges snaps whichever edge is closest and returns a shared delta', () => {
    const idx = new SnapIndex([
      { t: 10_000, kind: 'marker' },
      { t: 50_300, kind: 'clip' },
    ])
    // Start 9_000 is 1_000 away from the marker, end 50_000 only 300 from the clip edge.
    const hit = idx.snapEdges([9_000, 50_000], 2_000)
    expect(hit).toEqual({ target: { t: 50_300, kind: 'clip' }, edge: 1, delta: 300 })
    expect(idx.snapEdges([30_000, 31_000], 100)).toBeNull()
  })
})

describe('collectSnapTargets', () => {
  const p = project(
    [
      track('main', mainClips(1, 2)),
      track('overlay', [clip('video', sec(4), sec(1), { id: 'ov' })], 'o'),
    ],
    {
      markers: [
        { id: 'b', t: sec(0.5), kind: 'beat' },
        { id: 's', t: sec(1.5), kind: 'scene' },
        { id: 'u', t: sec(2.5), kind: 'user' },
      ],
    },
  )

  it('includes zero, playhead, clip edges and markers', () => {
    const t = collectSnapTargets(p, { playhead: sec(0.7) })
    const has = (time: number, kind: string) => t.some((x) => x.t === time && x.kind === kind)
    expect(has(0, 'zero')).toBe(true)
    expect(has(sec(0.7), 'playhead')).toBe(true)
    expect(has(sec(3), 'clip')).toBe(true)
    expect(has(sec(5), 'clip')).toBe(true)
    expect(has(sec(0.5), 'beat')).toBe(true)
    expect(has(sec(1.5), 'scene')).toBe(true)
    expect(has(sec(2.5), 'marker')).toBe(true)
  })

  it('excludes the dragged clips and optionally all clip edges', () => {
    const t = collectSnapTargets(p, { playhead: 0, exclude: new Set(['ov']) })
    expect(t.some((x) => x.t === sec(5))).toBe(false)
    const noClips = collectSnapTargets(p, { playhead: 0, clips: false })
    expect(noClips.some((x) => x.kind === 'clip')).toBe(false)
  })
})

describe('snapTime', () => {
  it('snaps to a target then to the frame grid', () => {
    const idx = new SnapIndex([{ t: 1_000_000, kind: 'marker' }])
    expect(snapTime(990_000, idx, 20_000, 30)).toEqual({
      t: 1_000_000,
      target: { t: 1_000_000, kind: 'marker' },
    })
    // No target in range: rounded to the nearest 30 fps frame.
    const r = snapTime(1_510_000, idx, 20_000, 30)
    expect(r.target).toBeNull()
    expect(r.t).toBe(1_500_000)
    expect(snapTime(17_000, null, 0, 30).t).toBe(Math.round(1_000_000 / 30))
  })
})
