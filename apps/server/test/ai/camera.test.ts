import { describe, expect, it } from 'vitest'
import {
  compressPath,
  deadZone,
  fillGaps,
  median3,
  planCamera,
  shotIndices,
  smoothSpring,
  type FrameFaces,
} from '../../src/ai/reframe/camera.ts'
import type { Face } from '../../src/ai/reframe/yunet.ts'

/** 16:9 detector frame. */
const W = 320
const H = 180
const DT = 200_000 // 5 Hz

const face = (cx: number, cy = 60, size = 40, score = 0.9): Face => ({
  x: cx - size / 2,
  y: cy - size / 2,
  w: size,
  h: size,
  score,
  landmarks: new Float32Array(10),
})

const frames = (n: number, gen: (i: number) => Face[]): FrameFaces[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * DT, faces: gen(i) }))

/** Linear interpolation of the path at time t (what a keyframe track would show). */
const at = (path: ReadonlyArray<{ t: number; x: number }>, t: number): number => {
  if (t <= path[0]!.t) return path[0]!.x
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    if (t <= b.t) return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t)
  }
  return path.at(-1)!.x
}

const opts = { frameWidth: W, frameHeight: H }

describe('planCamera', () => {
  it('centres the frame when there are no faces', () => {
    const r = planCamera(
      frames(50, () => []),
      opts,
    )
    expect(r.facesFound).toBe(0)
    expect(r.coverage).toBe(0)
    expect(r.path).toEqual([
      { t: 0, x: 0.5 },
      { t: 49 * DT, x: 0.5 },
    ])
  })

  it('returns an empty plan for no samples', () => {
    expect(planCamera([], opts)).toEqual({ path: [], facesFound: 0, coverage: 0 })
  })

  it('follows a subject moving left to right, smoothly and in order', () => {
    const n = 75 // 15 s
    const r = planCamera(
      frames(n, (i) => [face(40 + (240 * i) / (n - 1))]),
      opts,
    )
    expect(r.facesFound).toBe(1)
    expect(r.coverage).toBe(1)
    for (let i = 1; i < r.path.length; i++) {
      expect(r.path[i]!.t).toBeGreaterThan(r.path[i - 1]!.t)
      expect(r.path[i]!.x).toBeGreaterThanOrEqual(r.path[i - 1]!.x - 1e-4) // never pans backwards
    }
    for (let i = 5; i < n - 5; i++) {
      const truth = (40 + (240 * i) / (n - 1)) / W
      // Within the dead zone (12 % of a 9:16 crop ≈ 0.038 of the width) plus a little lag.
      expect(Math.abs(at(r.path, i * DT) - truth)).toBeLessThan(0.06)
    }
  })

  it('holds still while a subject only jitters inside the dead zone', () => {
    const r = planCamera(
      frames(50, (i) => [face(160 + (i % 2 ? 3 : -3))]),
      opts,
    )
    expect(r.path).toHaveLength(2)
    expect(r.path[0]!.x).toBeCloseTo(0.49, 1)
  })

  it('prefers the large, persistent face over a small one', () => {
    const r = planCamera(
      frames(40, () => [face(60, 60, 70), face(260, 60, 24)]),
      opts,
    )
    expect(r.facesFound).toBe(2)
    for (const p of r.path) expect(p.x).toBeCloseTo(60 / W, 2)
  })

  it('ignores a brief passer-by (switch hysteresis)', () => {
    const r = planCamera(
      frames(40, (i) =>
        i >= 20 && i < 23 ? [face(80, 60, 50), face(250, 90, 120)] : [face(80, 60, 50)],
      ),
      opts,
    )
    for (const p of r.path) expect(Math.abs(p.x - 80 / W)).toBeLessThan(0.01)
  })

  it('holds the last position through short detection drop-outs', () => {
    const r = planCamera(
      frames(30, (i) => (i >= 10 && i < 14 ? [] : [face(240)])),
      opts,
    )
    for (const p of r.path) expect(p.x).toBeCloseTo(0.75, 2)
    expect(r.coverage).toBeCloseTo(26 / 30, 3)
  })

  it('cuts instead of panning across a shot change', () => {
    const cut = 3_100_000
    const r = planCamera(
      frames(30, (i) => [face(i * DT < cut ? 50 : 270)]),
      { ...opts, cuts: [cut] },
    )
    const before = r.path.find((p) => p.t === cut - 1)
    const after = r.path.find((p) => p.t === cut)
    expect(before?.x).toBeCloseTo(50 / W, 2)
    expect(after?.x).toBeCloseTo(270 / W, 2)
    expect(r.facesFound).toBe(2) // tracks never cross a cut
  })

  it('outputs normalised, rounded x values within 0..1', () => {
    const r = planCamera(
      frames(20, (i) => [face(i % 2 ? 2 : 318, 60, 4)]),
      opts,
    )
    for (const p of r.path) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1)
      expect(Math.round(p.x * 10_000)).toBe(p.x * 10_000)
    }
  })
})

describe('camera building blocks', () => {
  it('shotIndices splits samples at cuts', () => {
    expect(Array.from(shotIndices([0, 1, 2, 3, 4], [2, 4]))).toEqual([0, 0, 1, 1, 2])
    expect(Array.from(shotIndices([0, 1], []))).toEqual([0, 0])
  })

  it('fillGaps holds, back-fills and centres empty shots', () => {
    const x = Float64Array.from([Number.NaN, 0.2, Number.NaN, 0.4, Number.NaN, Number.NaN])
    fillGaps(x, Int32Array.from([0, 0, 0, 0, 1, 1]), 0.5)
    expect(Array.from(x)).toEqual([0.2, 0.2, 0.2, 0.4, 0.5, 0.5])
  })

  it('median3 removes single-sample glitches but not shot boundaries', () => {
    const shots = Int32Array.from([0, 0, 0, 0, 1, 1])
    expect(Array.from(median3(Float64Array.from([0.1, 0.9, 0.1, 0.1, 0.8, 0.8]), shots))).toEqual([
      0.1, 0.1, 0.1, 0.1, 0.8, 0.8,
    ])
  })

  it('deadZone re-centres only when the subject leaves the zone or drifts', () => {
    const shots = new Int32Array(17)
    const x = Float64Array.from([0.5, 0.52, 0.48, 0.6, 0.61, ...Array<number>(12).fill(0.64)])
    const out = Array.from(deadZone(x, shots, 0.05))
    expect(out.slice(0, 5)).toEqual([0.5, 0.5, 0.5, 0.6, 0.6])
    // 0.64 is beyond half the zone from 0.6: after DRIFT_AFTER samples the camera re-centres.
    expect(out.at(-1)).toBe(0.64)
  })

  it('smoothSpring is zero-phase and never overshoots a step', () => {
    const n = 50
    const x = Float64Array.from({ length: n }, (_, i) => (i < 25 ? 0.2 : 0.8))
    const times = Array.from({ length: n }, (_, i) => i * DT)
    const y = smoothSpring(x, times, new Int32Array(n), 5)
    for (const v of y) {
      expect(v).toBeGreaterThanOrEqual(0.2 - 1e-9)
      expect(v).toBeLessThanOrEqual(0.8 + 1e-9)
    }
    // Symmetric around the step: the move starts before it (anticipation) and ends after.
    expect(y[22]!).toBeGreaterThan(0.21)
    expect(Math.abs(y[24]! - 0.2 + (y[25]! - 0.8))).toBeLessThan(0.05)
    for (let i = 1; i < n; i++) expect(y[i]!).toBeGreaterThanOrEqual(y[i - 1]! - 1e-9)
  })

  it('compressPath keeps the ends of constant runs only', () => {
    const p = [0.5, 0.5, 0.5, 0.6, 0.6, 0.6, 0.6].map((x, i) => ({ t: i, x }))
    expect(compressPath(p).map((q) => q.t)).toEqual([0, 2, 3, 6])
    expect(compressPath([])).toEqual([])
  })
})
