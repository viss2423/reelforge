import { describe, expect, it } from 'vitest'
import { planDecode, type DecodeRun } from './decodePlan.ts'
import type { SampleTable } from './mp4.ts'

/** A proxy-like table: `count` frames at 30 fps, keyframe every `gop`, no B-frames. */
function table(count: number, gop = 15): SampleTable {
  const cts = new Float64Array(count)
  const key = new Uint8Array(count)
  const presentation = new Uint32Array(count)
  for (let i = 0; i < count; i++) {
    cts[i] = Math.round((i * 1e6) / 30)
    key[i] = i % gop === 0 ? 1 : 0
    presentation[i] = i
  }
  return {
    count,
    offset: new Float64Array(count),
    size: new Uint32Array(count).fill(1),
    dts: cts.slice(),
    cts,
    duration: new Float64Array(count).fill(33_333),
    key,
    presentation,
    rank: presentation.slice(),
  }
}

const S = table(90)
const none = (): boolean => false
const heldSet =
  (...idx: number[]) =>
  (i: number): boolean =>
    idx.includes(i)
const run = (runStart: number, next: number): DecodeRun => ({ runStart, next })
const NEVER = Number.NEGATIVE_INFINITY

describe('planDecode', () => {
  it('starts a fresh decoder at the keyframe before the target', () => {
    expect(planDecode(S, run(-1, 0), 20, 0, none, NEVER)).toEqual({ reset: true, from: 15, to: 20 })
  })

  it('does nothing when the whole wanted window is held (no redundant re-decode)', () => {
    // e.g. right after a flush (runStart −1) the target and step-ahead frames are on hand
    const p = planDecode(S, run(-1, 0), 20, 2, heldSet(20, 21, 22), NEVER)
    expect(p.reset).toBe(false)
    expect(p.to).toBeLessThan(p.from)
  })

  it('continues the current run forward within a GOP', () => {
    expect(planDecode(S, run(15, 21), 25, 2, none, cts(20))).toEqual({
      reset: false,
      from: 21,
      to: 27,
    })
  })

  it('jumps to a later keyframe instead of decoding through', () => {
    expect(planDecode(S, run(0, 5), 40, 0, none, cts(4))).toEqual({ reset: true, from: 30, to: 40 })
  })

  it('restarts at a keyframe between the run and the target, else continues through it', () => {
    // next is 13, target 16: keyframe 15 lies in between → restart there (skips 13, 14)
    expect(planDecode(S, run(0, 13), 16, 0, none, cts(12)).reset).toBe(true)
    // with next == 15 the run simply continues through the keyframe
    expect(planDecode(S, run(0, 15), 16, 0, none, cts(14))).toEqual({
      reset: false,
      from: 15,
      to: 16,
    })
  })

  it('waits for frames already fed but not output yet (in flight)', () => {
    // fed up to 22, last output 18 → 20 is still coming: no reset
    const p = planDecode(S, run(15, 23), 20, 0, none, cts(18))
    expect(p.reset).toBe(false)
    expect(p.to).toBeLessThan(p.from) // nothing new to feed: from = next = 23 > to = 20
  })

  it('restarts when a fed frame was output and then dropped', () => {
    // last output 22 ≥ cts(20), yet 20 is not held → it was trimmed → decode again
    expect(planDecode(S, run(15, 23), 20, 0, none, cts(22))).toEqual({
      reset: true,
      from: 15,
      to: 20,
    })
  })

  it('restarts when going backwards before the run start', () => {
    expect(planDecode(S, run(30, 35), 10, 0, none, cts(34))).toEqual({
      reset: true,
      from: 0,
      to: 10,
    })
  })

  it('skips held frames and plans from the first missing one', () => {
    // 20, 21 held; 22 missing and already past the run → continue feeding to 26
    expect(planDecode(S, run(15, 22), 20, 6, heldSet(20, 21), cts(21))).toEqual({
      reset: false,
      from: 22,
      to: 26,
    })
  })

  it('clamps the target and read-ahead to the table', () => {
    expect(planDecode(S, run(-1, 0), 500, 6, none, NEVER)).toEqual({
      reset: true,
      from: 75,
      to: 89,
    })
    expect(planDecode(S, run(-1, 0), -3, 0, none, NEVER)).toEqual({ reset: true, from: 0, to: 0 })
  })

  it('writes into the provided output object (allocation-free)', () => {
    const out = { reset: false, from: 0, to: -1 }
    expect(planDecode(S, run(-1, 0), 3, 0, none, NEVER, out)).toBe(out)
  })
})

function cts(i: number): number {
  return S.cts[i]!
}
