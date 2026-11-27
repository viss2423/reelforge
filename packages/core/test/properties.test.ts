/**
 * Property-based tests: random op sequences must preserve every model invariant, and the
 * time-mapping / range ops must satisfy their algebraic laws for arbitrary inputs.
 */
import * as fc from 'fast-check'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import {
  MediaClip,
  OpError,
  addTrack,
  applyReframe,
  buildCaptions,
  copyClips,
  deleteClips,
  duplicateClip,
  insertAudioClip,
  insertMediaClip,
  insertStickerClip,
  insertTextClip,
  invertRanges,
  mainTrack,
  mergeRanges,
  moveClip,
  moveClips,
  normalizeMainTrack,
  pasteClips,
  removeSourceRanges,
  rollEdit,
  setClipSpeed,
  slipClip,
  sourceRange,
  sourceToTimeline,
  speedAt,
  speedProfile,
  splitClip,
  syncToBeats,
  timelineToSource,
  trimClip,
  validateProject,
  type Asset,
  type Clip,
  type Keyframe,
  type Project,
} from '../src/index.ts'
import { asset, captionStyle, project, words } from './helpers.ts'

const SEC = 1_000_000
const RUNS = Number(process.env.FC_RUNS ?? 150)

/* ------------------------------------------------------------------ random op model */

interface World {
  p: Project
  assets: Record<string, Asset>
  pool: Asset[]
}

function world(): World {
  const p = project()
  const pool = [
    asset({ duration: 8 * SEC }),
    asset({ duration: 3 * SEC }),
    asset({ kind: 'image' }),
    asset({ kind: 'audio', duration: 20 * SEC }),
  ]
  const assets = Object.fromEntries(pool.map((a) => [a.id, a]))
  addTrack(p, 'overlay')
  return { p, assets, pool }
}

const allClips = (p: Project): Clip[] => p.tracks.flatMap((t) => t.clips)
const pickClip = (p: Project, k: number): Clip | undefined => {
  const clips = allClips(p)
  return clips.length === 0 ? undefined : clips[k % clips.length]
}

type Op = (w: World) => void
const frac = fc.double({ min: 0, max: 1, noNaN: true })
const idx = fc.nat(1000)

const ops: fc.Arbitrary<Op>[] = [
  fc.record({ a: fc.nat(2), index: idx }).map(({ a, index }) => (w: World) => {
    const main = mainTrack(w.p)
    insertMediaClip(w.p, {
      trackId: main.id,
      asset: w.pool[a]!,
      index: index % (main.clips.length + 1),
      duration: 1 + (index % 4) * SEC,
    })
  }),
  fc.record({ a: fc.nat(2), at: fc.nat(10 * SEC) }).map(({ a, at }) => (w: World) => {
    const overlay = w.p.tracks.find((t) => t.kind === 'overlay')
    if (overlay) insertMediaClip(w.p, { trackId: overlay.id, asset: w.pool[a]!, at, duration: SEC })
  }),
  fc.record({ at: fc.nat(10 * SEC), d: fc.integer({ min: 1, max: 4 * SEC }) }).map(
    ({ at, d }) =>
      (w: World) =>
        void insertTextClip(w.p, { at, duration: d, text: 'Hello world' }),
  ),
  fc.nat(10 * SEC).map((at) => (w: World) => void insertAudioClip(w.p, { asset: w.pool[3]!, at })),
  fc.nat(10 * SEC).map((at) => (w: World) => void insertStickerClip(w.p, { at, ref: 'pack/s' })),
  fc.record({ k: idx, f: frac }).map(({ k, f }) => (w: World) => {
    const c = pickClip(w.p, k)
    if (!c) return
    const track = w.p.tracks.find((t) => t.clips.includes(c))!
    const start = track.kind === 'main' ? playbackStartOf(w.p, c) : c.start
    splitClip(w.p, c.id, Math.round(start + f * c.duration))
  }),
  fc
    .record({ k: idx, a: frac, b: frac, grow: fc.boolean() })
    .map(({ k, a, b, grow }) => (w: World) => {
      const c = pickClip(w.p, k)
      if (!c) return
      const track = w.p.tracks.find((t) => t.clips.includes(c))!
      const start = track.kind === 'main' ? playbackStartOf(w.p, c) : c.start
      const assetDuration = 'assetId' in c && c.assetId ? w.assets[c.assetId]?.duration : undefined
      const opts = assetDuration === undefined ? undefined : { asset: { duration: assetDuration } }
      if (grow) {
        trimClip(
          w.p,
          c.id,
          {
            start: Math.max(0, Math.round(start - a * SEC)),
            end: Math.round(start + c.duration + b * SEC),
          },
          opts,
        )
      } else {
        trimClip(
          w.p,
          c.id,
          {
            start: Math.round(start + (a * c.duration) / 3),
            end: Math.round(start + c.duration - (b * c.duration) / 3),
          },
          opts,
        )
      }
    }),
  fc
    .record({ k: idx, index: idx, at: fc.nat(10 * SEC), track: fc.nat(10) })
    .map(({ k, index, at, track }) => (w: World) => {
      const c = pickClip(w.p, k)
      if (!c) return
      const target = w.p.tracks[track % w.p.tracks.length]!
      if (index % 2 === 0) moveClip(w.p, c.id, { trackId: target.id, start: at })
      else moveClip(w.p, c.id, { trackId: target.id, index: index % 5 })
    }),
  fc
    .record({ ks: fc.array(idx, { maxLength: 3 }), ripple: fc.boolean() })
    .map(({ ks, ripple }) => (w: World) => {
      const ids = [...new Set(ks.map((k) => pickClip(w.p, k)?.id).filter((x) => x !== undefined))]
      deleteClips(w.p, ids, { ripple })
    }),
  idx.map((k) => (w: World) => {
    const c = pickClip(w.p, k)
    if (c) duplicateClip(w.p, c.id)
  }),
  fc
    .record({ k: idx, s: fc.double({ min: 0.1, max: 16, noNaN: true }) })
    .map(({ k, s }) => (w: World) => {
      const c = pickClip(w.p, k)
      if (c && (c.type === 'video' || c.type === 'audio')) setClipSpeed(w.p, c.id, s)
    }),
  fc
    .record({
      k: idx,
      ranges: fc.array(fc.tuple(fc.nat(10 * SEC), fc.nat(2 * SEC)), { maxLength: 4 }),
    })
    .map(({ k, ranges }) => (w: World) => {
      const c = pickClip(w.p, k)
      if (c && (c.type === 'video' || c.type === 'audio')) {
        removeSourceRanges(
          w.p,
          c.id,
          ranges.map(([s, d]) => ({ start: s, end: s + d })),
        )
      }
    }),
  fc
    .record({
      beats: fc.array(fc.nat(12 * SEC), { maxLength: 12 }),
      every: fc.constantFrom(1, 2, 4) as fc.Arbitrary<1 | 2 | 4>,
    })
    .map(
      ({ beats, every }) =>
        (w: World) =>
          syncToBeats(w.p, beats, { every }),
    ),
  fc
    .record({ k: idx, d: fc.integer({ min: 50_000, max: 3 * SEC }) })
    .map(({ k, d }) => (w: World) => {
      const main = mainTrack(w.p).clips
      const c = main[k % Math.max(1, main.length)]
      if (c && (c.type === 'video' || c.type === 'image')) {
        c.transitionIn = { type: 'fade', duration: d }
        normalizeMainTrack(w.p)
      }
    }),
  fc
    .record({
      k: idx,
      path: fc.array(fc.tuple(fc.nat(10 * SEC), frac), { minLength: 1, maxLength: 6 }),
    })
    .map(({ k, path }) => (w: World) => {
      const c = pickClip(w.p, k)
      if (c && (c.type === 'video' || c.type === 'image')) {
        applyReframe(
          w.p,
          c.id,
          path.map(([t, x]) => ({ t, x })),
        )
      }
    }),
  fc.constant((w: World) => {
    buildCaptions(
      w.p,
      { [w.pool[0]!.id]: words(20), [w.pool[1]!.id]: words(8, { from: 50_000 }) },
      captionStyle(),
    )
  }),
  fc
    .record({
      k: idx,
      ramp: fc.array(fc.tuple(fc.nat(3 * SEC), fc.double({ min: 0.25, max: 4, noNaN: true })), {
        minLength: 1,
        maxLength: 3,
      }),
    })
    .map(({ k, ramp }) => (w: World) => {
      // Ramps are set by the UI and must respect the asset: only accept ones that fit.
      const c = pickClip(w.p, k)
      if (!c || c.type !== 'video') return
      const before = c.speedRamp
      c.speedRamp = uniqueSorted(ramp.map(([t, v]) => ({ t, value: v, easing: 'easeInOut' })))
      const r = sourceRange(c)
      if (r.end > (w.assets[c.assetId]?.duration ?? 0)) c.speedRamp = before
    }),
  // Pro editing ops: slip, roll, ripple trim, copy/paste, group move.
  fc
    .record({ k: idx, d: fc.integer({ min: -6 * SEC, max: 6 * SEC }) })
    .map(({ k, d }) => (w: World) => {
      const c = pickClip(w.p, k)
      if (c && (c.type === 'video' || c.type === 'audio'))
        slipClip(w.p, c.id, d, { asset: w.assets[c.assetId] })
    }),
  fc
    .record({ k: idx, d: fc.integer({ min: -4 * SEC, max: 4 * SEC }) })
    .map(({ k, d }) => (w: World) => {
      const main = mainTrack(w.p).clips
      if (main.length < 2) return
      rollEdit(w.p, main[1 + (k % (main.length - 1))]!.id, d, { assets: w.assets })
    }),
  fc
    .record({ k: idx, d: fc.integer({ min: -2 * SEC, max: 2 * SEC }), head: fc.boolean() })
    .map(({ k, d, head }) => (w: World) => {
      const c = pickClip(w.p, k)
      if (!c) return
      const assetDuration = 'assetId' in c && c.assetId ? w.assets[c.assetId]?.duration : undefined
      const edges = head
        ? { start: Math.max(0, c.start + d) }
        : { end: Math.max(0, c.start + c.duration + d) }
      trimClip(w.p, c.id, edges, {
        ripple: true,
        ...(assetDuration === undefined ? {} : { asset: { duration: assetDuration } }),
      })
    }),
  fc
    .record({ ks: fc.array(idx, { maxLength: 3 }), at: fc.nat(12 * SEC) })
    .map(({ ks, at }) => (w: World) => {
      const ids = [...new Set(ks.map((k) => pickClip(w.p, k)?.id).filter((x) => x !== undefined))]
      pasteClips(w.p, copyClips(w.p, ids), { at })
    }),
  fc
    .record({ ks: fc.array(idx, { maxLength: 3 }), d: fc.integer({ min: -3 * SEC, max: 3 * SEC }) })
    .map(({ ks, d }) => (w: World) => {
      const free = w.p.tracks.filter((t) => t.kind !== 'main').flatMap((t) => t.clips)
      if (free.length === 0) return
      const picked = [...new Set(ks.map((k) => free[k % free.length]!))]
      moveClips(
        w.p,
        picked.map((c) => ({ clipId: c.id, start: Math.max(0, c.start + d) })),
      )
    }),
]

function uniqueSorted(kfs: Keyframe[]): Keyframe[] {
  const out: Keyframe[] = []
  for (const k of kfs.toSorted((a, b) => a.t - b.t)) if (out.at(-1)?.t !== k.t) out.push(k)
  return out
}

function playbackStartOf(p: Project, c: Clip): number {
  let cursor = 0
  let prev: number | undefined
  for (const m of mainTrack(p).clips) {
    let overlap = 0
    if (m.type !== 'audio' && 'transitionIn' in m && m.transitionIn && prev !== undefined) {
      const d = Math.min(m.transitionIn.duration, Math.floor(prev / 2), Math.floor(m.duration / 2))
      overlap = d >= 50_000 ? d : 0
    }
    const start = cursor - overlap
    if (m.id === c.id) return start
    cursor = start + m.duration
    prev = m.duration
  }
  return c.start
}

const run = (w: World, op: Op) => {
  try {
    op(w)
  } catch (e) {
    // Refusals of invalid requests are part of the contract; anything else is a bug.
    if (!(e instanceof OpError)) throw e
  }
}

describe('random op sequences', () => {
  it('always keep validateProject() == []', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(...ops), { minLength: 1, maxLength: 25 }), (seq) => {
        const w = world()
        for (const op of seq) {
          run(w, op)
          expect(validateProject(w.p, w.assets), `after ${JSON.stringify(op)}`).toEqual([])
        }
      }),
      { numRuns: RUNS },
    )
  })

  it('work on Immer drafts and never mutate the base state', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(...ops), { minLength: 1, maxLength: 10 }), (seq) => {
        const w = world()
        let state = w.p
        for (const op of seq) {
          const before = JSON.stringify(state)
          const next = produce(state, (draft) => run({ ...w, p: draft }, op))
          expect(JSON.stringify(state)).toBe(before)
          state = next
        }
        expect(validateProject(state, w.assets)).toEqual([])
      }),
      { numRuns: Math.ceil(RUNS / 3) },
    )
  })
})

/* ------------------------------------------------------------------ time mapping laws */

const clipArb = fc
  .record({
    in: fc.nat(5 * SEC),
    duration: fc.integer({ min: 40_000, max: 6 * SEC }),
    speed: fc.double({ min: 0.1, max: 16, noNaN: true }),
    reverse: fc.boolean(),
    ramp: fc.array(
      fc.record({
        t: fc.nat(6 * SEC),
        value: fc.double({ min: 0.1, max: 8, noNaN: true }),
        easing: fc.constantFrom(
          'linear',
          'easeIn',
          'easeOut',
          'easeInOut',
          'easeOutBack',
          'hold',
        ) as fc.Arbitrary<Keyframe['easing']>,
      }),
      { maxLength: 4 },
    ),
  })
  .map((r) =>
    MediaClip.parse({
      id: 'c',
      type: 'video',
      assetId: 'a',
      start: 2 * SEC,
      duration: r.duration,
      in: r.in,
      speed: r.speed,
      reverse: r.reverse,
      speedRamp: uniqueSorted(r.ramp),
    }),
  )
  // Overshooting easings can dip a ramp to ≤ 0, which validateProject rejects.
  .filter((c) => {
    const end = Math.max(c.duration, c.speedRamp.at(-1)?.t ?? 0)
    for (let i = 0; i <= 500; i++) if (!(speedAt(c, (i / 500) * end) > 0.02 * c.speed)) return false
    return true
  })

/** Upper bound of the instantaneous playback rate (easeOutBack overshoots by ≤ 10 %). */
const maxRate = (clip: MediaClip): number =>
  clip.speed * Math.max(1, ...clip.speedRamp.map((k) => k.value)) * 1.1

describe('time mapping', () => {
  it('timelineToSource ∘ sourceToTimeline ≈ identity on the source span', () => {
    fc.assert(
      fc.property(clipArb, frac, (clip, f) => {
        const range = sourceRange(clip)
        const s = Math.round(range.start + f * (range.end - range.start))
        const t = sourceToTimeline(clip, s)
        expect(t).toBeDefined()
        // One µs of timeline time covers up to maxRate µs of source (rounding of t).
        const prof = speedProfile(clip)
        expect(Math.abs(timelineToSource(clip, t!) - s)).toBeLessThanOrEqual(
          Math.ceil(maxRate(clip)) + 2,
        )
        expect(prof.offsetAt(prof.timeAt(1000))).toBeCloseTo(1000, 0)
      }),
      { numRuns: RUNS * 2 },
    )
  })

  it('sourceToTimeline ∘ timelineToSource ≈ identity on the clip', () => {
    fc.assert(
      fc.property(clipArb, frac, (clip, f) => {
        const t = clip.start + Math.round(f * clip.duration)
        const s = timelineToSource(clip, t)
        const back = sourceToTimeline(clip, s)
        expect(back).toBeDefined()
        expect(Math.abs(timelineToSource(clip, back!) - s)).toBeLessThanOrEqual(
          Math.ceil(maxRate(clip)) + 2,
        )
      }),
      { numRuns: RUNS * 2 },
    )
  })
})

/* ------------------------------------------------------------------ split / remove laws */

describe('split and removeSourceRanges', () => {
  it('split halves partition the source span exactly', () => {
    fc.assert(
      fc.property(clipArb, frac, (clip, f) => {
        const p = project()
        const c = structuredClone(clip)
        c.start = 0
        mainTrack(p).clips.push(c)
        const tau = Math.round(34_000 + f * (c.duration - 68_000))
        const whole = sourceRange(c)
        fc.pre(c.duration >= 68_000)
        const [a, b] = splitClip(p, c.id, tau) as [MediaClip, MediaClip]
        const ra = sourceRange(a)
        const rb = sourceRange(b)
        const lo = Math.min(ra.start, rb.start)
        const hi = Math.max(ra.end, rb.end)
        // Durations are whole µs, so a piece edge is exact to one timeline µs of source.
        const tol = Math.ceil(maxRate(clip)) + 2
        expect(Math.abs(lo - whole.start)).toBeLessThanOrEqual(tol)
        expect(Math.abs(hi - whole.end)).toBeLessThanOrEqual(tol)
        const gap = clip.reverse ? Math.abs(rb.end - ra.start) : Math.abs(ra.end - rb.start)
        expect(gap).toBeLessThanOrEqual(tol)
      }),
      { numRuns: RUNS },
    )
  })

  it('never yields overlapping clips and removes exactly the requested source', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 * SEC }),
        fc.double({ min: 0.25, max: 4, noNaN: true }),
        fc.boolean(),
        fc.array(fc.tuple(fc.nat(10 * SEC), fc.nat(3 * SEC)), { maxLength: 6 }),
        fc.boolean(),
        (duration, speed, reverse, raw, onMain) => {
          const p = project()
          const a = asset({ duration: 40 * SEC })
          const track = onMain ? mainTrack(p) : addTrack(p, 'overlay')
          const c = insertMediaClip(p, {
            trackId: track.id,
            asset: a,
            at: SEC,
            duration: Math.max(40_000, duration),
          })
          c.speed = Math.round(speed * 100) / 100
          c.reverse = reverse
          const whole = sourceRange(c)
          const ranges = raw.map(([s, d]) => ({ start: s, end: s + d }))
          removeSourceRanges(p, c.id, ranges)
          expect(validateProject(p, { [a.id]: a })).toEqual([])
          const kept = track.clips.map((x) => sourceRange(x as MediaClip))
          // Pieces never overlap in source time and avoid every removed range (± rounding).
          const merged = mergeRanges(ranges)
          const sortedKept = kept.toSorted((x, y) => x.start - y.start)
          for (let i = 1; i < sortedKept.length; i++) {
            expect(sortedKept[i]!.start).toBeGreaterThanOrEqual(sortedKept[i - 1]!.end - 2)
          }
          for (const k of kept) {
            for (const r of merged) {
              const overlap = Math.min(k.end, r.end) - Math.max(k.start, r.start)
              expect(overlap).toBeLessThanOrEqual(Math.ceil(c.speed) + 2)
            }
          }
          // Total kept source ≈ span − removed (sub-frame pieces may additionally drop).
          const expected = invertRanges(ranges, whole.start, whole.end).reduce(
            (s, r) => s + r.end - r.start,
            0,
          )
          const got = kept.reduce((s, r) => s + r.end - r.start, 0)
          expect(got).toBeLessThanOrEqual(expected + kept.length * (Math.ceil(c.speed) + 2))
          expect(expected - got).toBeLessThanOrEqual((merged.length + 1) * 34_000 * c.speed + 10)
        },
      ),
      { numRuns: RUNS },
    )
  })
})
