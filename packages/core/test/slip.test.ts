/**
 * Slip, roll, ripple trim, copy/paste and group moves: unit cases plus property tests for
 * their algebraic laws (what must stay fixed, exact inverses, limits).
 */
import * as fc from 'fast-check'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import {
  OpError,
  addTrack,
  copyClips,
  insertMediaClip,
  insertTextClip,
  mainTrack,
  mainTrackLayout,
  moveClips,
  pasteClips,
  projectDuration,
  rollEdit,
  rollLimits,
  slipClip,
  slipLimits,
  sourceRange,
  timelineToSource,
  trimClip,
  validateProject,
  type MediaClip,
  type Project,
} from '../src/index.ts'
import { asset, project, projectWithMain, textClip } from './helpers.ts'

const SEC = 1_000_000
const RUNS = Number(process.env.FC_RUNS ?? 150)

const mainClips = (p: Project) => mainTrack(p).clips as MediaClip[]
const durations = (p: Project) => mainClips(p).map((c) => c.duration)

/* ------------------------------------------------------------------ slip */

describe('slipClip', () => {
  const setup = (inPoint: number, duration = 2 * SEC, speed = 1) => {
    const { p, clips, assets } = projectWithMain([duration, 3 * SEC])
    const c = clips[0]!
    c.in = inPoint
    c.speed = speed
    return { p, c, a: assets[c.assetId]!, assets }
  }

  it('moves the content inside a fixed span', () => {
    const { p, c, a, assets } = setup(SEC)
    const applied = slipClip(p, c.id, 500_000, { asset: a })
    expect(applied).toBe(500_000)
    expect(c.in).toBe(1_500_000)
    expect(c.start).toBe(0)
    expect(c.duration).toBe(2 * SEC)
    expect(durations(p)).toEqual([2 * SEC, 3 * SEC])
    expect(validateProject(p, assets)).toEqual([])
  })

  it('clamps at the head and the tail of the source', () => {
    const { p, c, a } = setup(SEC)
    expect(slipClip(p, c.id, -5 * SEC, { asset: a })).toBe(-SEC)
    expect(c.in).toBe(0)
    // 10 s asset, 2 s span: the in-point can reach 8 s.
    expect(slipClip(p, c.id, 60 * SEC, { asset: a })).toBe(8 * SEC)
    expect(sourceRange(c).end).toBe(10 * SEC)
    expect(slipClip(p, c.id, SEC, { asset: a })).toBe(0)
  })

  it('accounts for speed in the source span', () => {
    const { p, c, a } = setup(0, 2 * SEC, 2)
    // 2 s at 2× covers 4 s of source: 6 s of room.
    expect(slipLimits(c, a)).toEqual({ min: 0, max: 6 * SEC })
    expect(slipClip(p, c.id, 99 * SEC, { asset: a })).toBe(6 * SEC)
  })

  it('is unbounded above without an asset duration', () => {
    const { c } = setup(SEC)
    expect(slipLimits(c, undefined)).toEqual({ min: -SEC, max: Infinity })
  })

  it('refuses clips without source time and locked tracks', () => {
    const p = project()
    const t = insertTextClip(p, { at: 0, text: 'hi' })
    expect(() => slipClip(p, t.id, SEC)).toThrow(OpError)
    const { p: p2, c } = setup(SEC)
    mainTrack(p2).locked = true
    expect(() => slipClip(p2, c.id, SEC)).toThrow(/locked/)
  })

  it('slip(d) then slip(-applied) restores the clip exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 * SEC }),
        fc.integer({ min: 40_000, max: 4 * SEC }),
        fc.double({ min: 0.25, max: 4, noNaN: true }),
        fc.boolean(),
        fc.integer({ min: -12 * SEC, max: 12 * SEC }),
        (inPoint, duration, speed, reverse, delta) => {
          const a = asset({ duration: 20 * SEC })
          const p = project()
          const c = insertMediaClip(p, { trackId: mainTrack(p).id, asset: a, duration })
          c.speed = speed
          c.reverse = reverse
          c.in = Math.min(inPoint, Math.max(0, 20 * SEC - sourceRange(c).end))
          const before = JSON.stringify(p)
          const limits = slipLimits(c, a)
          const applied = slipClip(p, c.id, delta, { asset: a })
          expect(applied).toBe(Math.round(Math.min(limits.max, Math.max(limits.min, delta))))
          expect(c.duration).toBe(duration)
          expect(c.start).toBe(0)
          expect(sourceRange(c).start).toBeGreaterThanOrEqual(0)
          expect(sourceRange(c).end).toBeLessThanOrEqual(20 * SEC)
          expect(validateProject(p, { [a.id]: a })).toEqual([])
          slipClip(p, c.id, -applied, { asset: a })
          expect(JSON.stringify(p)).toBe(before)
        },
      ),
      { numRuns: RUNS },
    )
  })
})

/* ------------------------------------------------------------------ roll */

describe('rollEdit', () => {
  const setup = () => {
    const { p, clips, assets } = projectWithMain([2 * SEC, 2 * SEC, 2 * SEC])
    clips[0]!.in = 0
    clips[1]!.in = 3 * SEC
    clips[2]!.in = 0
    return { p, clips, assets }
  }

  it('moves the cut and keeps everything else in place', () => {
    const { p, clips, assets } = setup()
    const total = projectDuration(p)
    expect(rollEdit(p, clips[1]!.id, 500_000, { assets })).toBe(500_000)
    expect(durations(p)).toEqual([2_500_000, 1_500_000, 2 * SEC])
    // The incoming clip keeps showing the frames it showed after the cut.
    expect(clips[1]!.in).toBe(3_500_000)
    expect(mainClips(p)[2]!.start).toBe(4 * SEC)
    expect(projectDuration(p)).toBe(total)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('rolls earlier by revealing the incoming head', () => {
    const { p, clips, assets } = setup()
    expect(rollEdit(p, clips[1]!.id, -SEC, { assets })).toBe(-SEC)
    expect(durations(p)).toEqual([SEC, 3 * SEC, 2 * SEC])
    expect(clips[1]!.in).toBe(2 * SEC)
  })

  it('is limited by the source and the one-frame minimum', () => {
    const { p, clips, assets } = setup()
    const minFrame = Math.floor(SEC / 30)
    // Earlier: the incoming clip has 3 s of head room, the outgoing can shrink by 2 s − 1f.
    expect(rollLimits(p, clips[1]!.id, assets)).toEqual({
      min: -(2 * SEC - minFrame),
      max: 2 * SEC - minFrame,
    })
    // First clip of the asset starts at 0: the cut into it cannot move earlier.
    expect(rollLimits(p, clips[2]!.id, assets).min).toBe(0)
  })

  it('refuses the first clip and non-main clips', () => {
    const { p, clips } = setup()
    expect(() => rollEdit(p, clips[0]!.id, SEC)).toThrow(/first clip/)
    const t = insertTextClip(p, { at: 0, text: 'x' })
    expect(() => rollEdit(p, t.id, SEC)).toThrow(/main-track/)
  })

  it('keeps the total length, other clips and the source continuity (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 100_000, max: 3 * SEC }), { minLength: 2, maxLength: 5 }),
        fc.nat(10),
        fc.integer({ min: -4 * SEC, max: 4 * SEC }),
        fc.array(fc.nat(6 * SEC), { minLength: 5, maxLength: 5 }),
        (ds, k, delta, ins) => {
          const { p, clips, assets } = projectWithMain(ds)
          clips.forEach((c, i) => (c.in = Math.min(ins[i]!, 10 * SEC - c.duration)))
          const i = 1 + (k % (clips.length - 1))
          const left = clips[i - 1]!
          const right = clips[i]!
          const total = projectDuration(p)
          const others = clips
            .filter((c) => c !== left && c !== right)
            .map((c) => JSON.stringify(c))
          const cutSource = timelineToSource(right, right.start)
          const leftSource = left.in
          const { min, max } = rollLimits(p, right.id, assets)
          const applied = rollEdit(p, right.id, delta, { assets })
          expect(applied).toBe(Math.min(max, Math.max(min, delta)))
          expect(projectDuration(p)).toBe(total)
          expect(left.duration + right.duration).toBe(ds[i - 1]! + ds[i]!)
          expect(
            clips.filter((c) => c !== left && c !== right).map((c) => JSON.stringify(c)),
          ).toEqual(others)
          // The outgoing clip's head and the incoming clip's tail never move in source time.
          expect(left.in).toBe(leftSource)
          expect(right.in + right.duration).toBe(cutSource + ds[i]!)
          expect(validateProject(p, assets)).toEqual([])
          // Exact inverse.
          rollEdit(p, right.id, -applied, { assets })
          expect(durations(p)).toEqual(ds)
        },
      ),
      { numRuns: RUNS },
    )
  })
})

/* ------------------------------------------------------------------ ripple trim */

describe('trimClip with ripple on free tracks', () => {
  const setup = () => {
    const p = project()
    const text = p.tracks.find((t) => t.kind === 'text')!
    text.clips.push(
      textClip({ id: 'a', start: 0, duration: 2 * SEC }),
      textClip({ id: 'b', start: 2 * SEC, duration: SEC }),
      textClip({ id: 'c', start: 4 * SEC, duration: SEC }),
    )
    return { p, text }
  }

  it('grows the tail past the neighbour and shifts later clips', () => {
    const { p, text } = setup()
    trimClip(p, 'a', { end: 3 * SEC }, { ripple: true })
    expect(text.clips.map((c) => [c.id, c.start, c.duration])).toEqual([
      ['a', 0, 3 * SEC],
      ['b', 3 * SEC, SEC],
      ['c', 5 * SEC, SEC],
    ])
    expect(validateProject(p)).toEqual([])
  })

  it('keeps the start on a head trim and pulls later clips in', () => {
    const { p, text } = setup()
    trimClip(p, 'b', { start: 2_500_000 }, { ripple: true })
    expect(text.clips.map((c) => [c.id, c.start, c.duration])).toEqual([
      ['a', 0, 2 * SEC],
      ['b', 2 * SEC, 500_000],
      ['c', 3_500_000, SEC],
    ])
  })

  it('without ripple is still limited by the neighbour', () => {
    const { p, text } = setup()
    trimClip(p, 'a', { end: 3 * SEC })
    expect(text.clips[0]!.duration).toBe(2 * SEC)
  })

  it('preserves every gap and the order (property)', () => {
    fc.assert(
      fc.property(
        fc.nat(2),
        fc.boolean(),
        fc.integer({ min: -2 * SEC, max: 3 * SEC }),
        (k, head, delta) => {
          const { p, text } = setup()
          const target = text.clips[k]!
          const gapsBefore = text.clips.slice(1).map((c, i) => {
            const prev = text.clips[i]!
            return c.start - (prev.start + prev.duration)
          })
          const edges = head
            ? { start: Math.max(0, target.start + delta) }
            : { end: Math.max(0, target.start + target.duration + delta) }
          try {
            trimClip(p, target.id, edges, { ripple: true })
          } catch (e) {
            if (!(e instanceof OpError)) throw e
            return
          }
          const gapsAfter = text.clips.slice(1).map((c, i) => {
            const prev = text.clips[i]!
            return c.start - (prev.start + prev.duration)
          })
          expect(gapsAfter).toEqual(gapsBefore)
          expect(text.clips.map((c) => c.id)).toEqual(['a', 'b', 'c'])
          expect(validateProject(p)).toEqual([])
        },
      ),
      { numRuns: RUNS },
    )
  })
})

/* ------------------------------------------------------------------ copy / paste */

describe('copyClips / pasteClips', () => {
  const setup = () => {
    const { p, clips, assets } = projectWithMain([2 * SEC, 2 * SEC])
    const overlay = addTrack(p, 'overlay')
    const ov = insertMediaClip(p, {
      trackId: overlay.id,
      asset: assets[clips[0]!.assetId]!,
      at: SEC,
      duration: SEC,
    })
    const t = insertTextClip(p, { at: 1_500_000, duration: SEC, text: 'Hi' })
    return { p, clips, assets, overlay, ov, t }
  }

  it('copies without touching the project and keeps relative offsets', () => {
    const { p, ov, t } = setup()
    const before = JSON.stringify(p)
    const data = copyClips(p, [t.id, ov.id])
    expect(JSON.stringify(p)).toBe(before)
    expect(data.entries.map((e) => [e.clip.id, e.offset])).toEqual([
      [ov.id, 0],
      [t.id, 500_000],
    ])
    expect(data.duration).toBe(1_500_000)
    // Plain JSON: survives storage.
    expect(JSON.parse(JSON.stringify(data))).toEqual(data)
  })

  it('pastes across tracks at a time with fresh ids', () => {
    const { p, ov, t, assets, overlay } = setup()
    const data = copyClips(p, [t.id, ov.id])
    const pasted = pasteClips(p, data, { at: 5 * SEC })
    expect(pasted).toHaveLength(2)
    expect(new Set(pasted.map((c) => c.id)).size).toBe(2)
    expect(pasted.some((c) => c.id === t.id || c.id === ov.id)).toBe(false)
    const [pov, pt] = pasted
    expect(pov!.start).toBe(5 * SEC)
    expect(pt!.start).toBe(5_500_000)
    expect(overlay.clips.some((c) => c.id === pov!.id)).toBe(true)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('inserts main clips at the nearest boundary and ripples', () => {
    const { p, clips, assets } = setup()
    const data = copyClips(p, [clips[0]!.id])
    const [copy] = pasteClips(p, data, { at: 2 * SEC })
    expect(mainClips(p).map((c) => c.id)).toEqual([clips[0]!.id, copy!.id, clips[1]!.id])
    expect(mainTrackLayout(p).at(-1)!.end).toBe(6 * SEC)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('lands on another track when the original slot is taken', () => {
    const { p, ov, assets } = setup()
    const data = copyClips(p, [ov.id])
    pasteClips(p, data, { at: SEC })
    expect(p.tracks.filter((tr) => tr.kind === 'overlay')).toHaveLength(2)
    expect(validateProject(p, assets)).toEqual([])
  })

  it('works on Immer drafts (property: any selection, any time)', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(10), { maxLength: 4 }), fc.nat(12 * SEC), (picks, at) => {
        const { p, assets } = setup()
        const all = p.tracks.flatMap((tr) => tr.clips)
        const ids = [...new Set(picks.map((k) => all[k % all.length]!.id))]
        const data = copyClips(p, ids)
        const next = produce(p, (d) => {
          const pasted = pasteClips(d, data, { at })
          expect(pasted).toHaveLength(ids.length)
        })
        expect(next.tracks.flatMap((tr) => tr.clips)).toHaveLength(all.length + ids.length)
        expect(validateProject(next, assets)).toEqual([])
      }),
      { numRuns: RUNS },
    )
  })
})

/* ------------------------------------------------------------------ group move */

describe('moveClips', () => {
  const setup = () => {
    const p = project()
    const text = p.tracks.find((t) => t.kind === 'text')!
    text.clips.push(
      textClip({ id: 'a', start: 0, duration: SEC }),
      textClip({ id: 'b', start: SEC, duration: SEC }),
    )
    return { p, text }
  }

  it('swaps adjacent clips in one step (no collision with old slots)', () => {
    const { p, text } = setup()
    moveClips(p, [
      { clipId: 'a', start: SEC },
      { clipId: 'b', start: 0 },
    ])
    expect(text.clips.map((c) => [c.id, c.start])).toEqual([
      ['b', 0],
      ['a', SEC],
    ])
    expect(validateProject(p)).toEqual([])
  })

  it('moves a group to another track of the same kind', () => {
    const { p } = setup()
    const other = addTrack(p, 'text')
    moveClips(p, [
      { clipId: 'a', start: 3 * SEC, trackId: other.id },
      { clipId: 'b', start: 4 * SEC, trackId: other.id },
    ])
    expect(other.clips.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('refuses main clips and incompatible tracks', () => {
    const { p } = setup()
    const audio = p.tracks.find((t) => t.kind === 'audio')!
    expect(() => moveClips(p, [{ clipId: 'a', start: 0, trackId: audio.id }])).toThrow(/cannot go/)
    const m = projectWithMain([SEC])
    expect(() => moveClips(m.p, [{ clipId: m.clips[0]!.id, start: SEC }])).toThrow(/main/)
  })

  it('keeps every invariant for random group moves (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(3), fc.nat(8 * SEC), fc.nat(2)), { minLength: 1, maxLength: 4 }),
        (moves) => {
          const p = project()
          const text = p.tracks.find((t) => t.kind === 'text')!
          const t2 = addTrack(p, 'text')
          text.clips.push(
            textClip({ id: 'a', start: 0, duration: SEC }),
            textClip({ id: 'b', start: SEC, duration: SEC }),
            textClip({ id: 'c', start: 3 * SEC, duration: 2 * SEC }),
            textClip({ id: 'd', start: 6 * SEC, duration: SEC }),
          )
          const ids = ['a', 'b', 'c', 'd']
          const seen = new Set<string>()
          const list = moves
            .map(([k, start, tr]) => ({
              clipId: ids[k]!,
              start,
              ...(tr === 1 ? { trackId: t2.id } : {}),
            }))
            .filter((m) => !seen.has(m.clipId) && (seen.add(m.clipId), true))
          moveClips(p, list)
          expect(p.tracks.flatMap((tr) => tr.clips)).toHaveLength(4)
          expect(validateProject(p)).toEqual([])
          for (const m of list) {
            const found = p.tracks.flatMap((tr) => tr.clips).find((c) => c.id === m.clipId)!
            expect(found.start).toBe(m.start)
          }
        },
      ),
      { numRuns: RUNS },
    )
  })
})
