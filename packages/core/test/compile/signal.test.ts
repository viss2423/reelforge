import { describe, expect, it } from 'vitest'
import { sampledCommands, sendcmdFilter } from '../../src/compile/cmd.ts'
import {
  inverseAffinePoint,
  perspectiveFilter,
  rotateZoomInverse,
} from '../../src/compile/geometry.ts'
import {
  add,
  constant,
  fromAnimatable,
  fromKeyframes,
  fromPresetTrack,
  mul,
  sampleFrames,
  signalRange,
  windowed,
  type Signal,
} from '../../src/compile/signal.ts'
import { evalExpr, getToken } from './helpers.ts'

/** Largest difference between the FFmpeg and JS backends of a signal over [0, untilUs]. */
const backendError = (s: Signal, untilUs: number): number => {
  let worst = 0
  for (let us = 0; us <= untilUs; us += untilUs / 97) {
    worst = Math.max(worst, Math.abs(evalExpr(s.expr('(t)'), { t: us / 1e6 }) - s.at(us)))
  }
  return worst
}

describe('signals', () => {
  const kfs = fromKeyframes(
    [
      { t: 0, value: 0, easing: 'linear' },
      { t: 1_000_000, value: 10, easing: 'easeOutBack' },
      { t: 2_000_000, value: 4, easing: 'hold' },
    ],
    0,
    { mul: 2, add: 1 },
  )

  it('keyframe signals agree between the FFmpeg and JS backends', () => {
    expect(kfs.constant).toBeUndefined()
    expect(backendError(kfs, 2_500_000)).toBeLessThan(1e-5)
  })

  it('folds constants in add/mul', () => {
    expect(add(constant(1), constant(2)).constant).toBe(3)
    expect(mul(constant(2), constant(3)).constant).toBe(6)
    expect(mul(kfs, constant(0)).constant).toBe(0)
    expect(mul(kfs, constant(1))).toBe(kfs)
    expect(add(kfs, constant(0))).toBe(kfs)
    expect(add().constant).toBe(0)
    expect(mul().constant).toBe(1)
  })

  it('combined signals agree between backends', () => {
    const s = mul(
      add(kfs, constant(3)),
      fromAnimatable({
        value: 1,
        keyframes: [
          { t: 0, value: 1, easing: 'linear' },
          { t: 2_000_000, value: 2, easing: 'easeIn' },
        ],
      }),
    )
    expect(backendError(s, 2_000_000)).toBeLessThan(1e-5)
    const w = windowed(500_000, 1_500_000, { expr: (l) => `${l}*2`, at: (us) => (us / 1e6) * 2 }, 7)
    expect(backendError(w, 2e6)).toBeLessThan(1e-5)
  })

  it('offsets keyframes and handles constant inputs', () => {
    const s = fromKeyframes(
      [
        { t: 0, value: 0, easing: 'linear' },
        { t: 1e6, value: 1, easing: 'linear' },
      ],
      0,
      { offsetUs: 500_000 },
    )
    expect(s.at(500_000)).toBe(0)
    expect(s.at(1_000_000)).toBeCloseTo(0.5, 9)
    expect(fromKeyframes([], 5, { mul: 2 }).constant).toBe(10)
  })

  it('places normalised preset tracks on the clip timeline', () => {
    const s = fromPresetTrack(
      [
        { t: 0, value: 0, easing: 'linear' },
        { t: 1, value: 1, easing: 'linear' },
      ],
      1,
      1_000_000,
      500_000,
    )
    expect(s.at(0)).toBe(0)
    expect(s.at(1_250_000)).toBeCloseTo(0.5, 9)
    expect(s.at(9e6)).toBe(1)
    expect(fromPresetTrack(undefined, 1, 0, 1).constant).toBe(1)
    expect(fromPresetTrack([{ t: 0, value: 3, easing: 'linear' }], 1, 0, 0).constant).toBe(1)
  })

  it('samples frames and finds ranges including overshoot', () => {
    expect(sampleFrames(constant(2), 100_000, 30)).toEqual([2, 2, 2])
    const r = signalRange(kfs, 2_000_000, 30)
    expect(r.min).toBe(1)
    expect(r.max).toBeGreaterThan(21)
  })
})

describe('sendcmd', () => {
  it('emits a command only when the formatted value changes, half a frame early', () => {
    const cmds = sampledCommands({
      target: 'gblur@x',
      command: 'sigma',
      signal: { constant: undefined, expr: () => '0', at: (us) => (us < 100_000 ? 5 : 2) },
      fromUs: 0,
      toUs: 300_000,
      fps: 10,
      offsetUs: 1_000_000,
    })
    expect(cmds.map((c) => c.arg)).toEqual(['5', '2'])
    expect(cmds[0]!.t).toBeCloseTo(0.95, 9)
    expect(cmds[1]!.t).toBeCloseTo(1.05, 9)
  })

  it('builds a quoted sendcmd filter sorted by time', () => {
    expect(sendcmdFilter([])).toBeUndefined()
    const f = sendcmdFilter([
      { t: 1, target: 'a@x', command: 'c', arg: '2' },
      { t: 0.5, target: 'a@x', command: 'c', arg: 'val*0.5' },
    ])!
    expect(f.startsWith('sendcmd=c=')).toBe(true)
    const text = getToken(getToken(f.slice('sendcmd=c='.length), 0, '').value, 0, '').value
    expect(text).toBe('0.5 a@x c val*0.5;1 a@x c 2')
  })
})

describe('perspective geometry', () => {
  it('expression and JS inverse maps agree (rotation + zoom)', () => {
    const o = { ocx: 500, ocy: 900, scx: 540, scy: 960, z: 1.3, theta: 0.4 }
    const inv = rotateZoomInverse({
      ocx: String(o.ocx),
      ocy: String(o.ocy),
      scx: String(o.scx),
      scy: String(o.scy),
      z: String(o.z),
      theta: String(o.theta),
    })
    for (const [u, v] of [
      [0, 0],
      [1080, 0],
      [0, 1920],
      [1080, 1920],
      [321, 777],
    ] as const) {
      const p = inv.map(u, v)
      const ref = inverseAffinePoint(u, v, o)
      expect(evalExpr(p.x)).toBeCloseTo(ref.x, 6)
      expect(evalExpr(p.y)).toBeCloseTo(ref.y, 6)
    }
  })

  it('without rotation the output point (ocx, ocy) shows the source point (scx, scy)', () => {
    const inv = rotateZoomInverse({
      ocx: '100',
      ocy: '200',
      scx: '50',
      scy: '60',
      z: '2',
      theta: undefined,
    })
    const p = inv.map(100, 200)
    expect(evalExpr(p.x)).toBe(50)
    expect(evalExpr(p.y)).toBe(60)
    expect(evalExpr(inv.map(102, 200).x)).toBe(51)
  })

  it('emits a perspective filter with frame evaluation', () => {
    const f = perspectiveFilter(
      1080,
      1920,
      rotateZoomInverse({
        ocx: '540',
        ocy: '960',
        scx: '540',
        scy: '960',
        z: '1',
        theta: undefined,
      }),
      { enable: 'between(t,1,2)' },
    )
    expect(f).toMatch(/^perspective=x0=/)
    expect(f).toContain('interpolation=linear')
    expect(f).toContain('eval=frame')
    expect(f).toContain("enable='between(t,1,2)'")
  })
})
