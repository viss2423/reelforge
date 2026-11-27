/**
 * Smart reframe planner (subject selection, speaker, groups, fallbacks, strength) and the
 * small detector helpers (D-FINE decode, saliency box, mouth activity). Pure functions on
 * synthetic detections with known ground truth.
 */
import { describe, expect, it } from 'vitest'
import { facePatches, lumaGrid, RmsEnvelope, speechLevels } from '../../src/ai/reframe/activity.ts'
import { planCamera } from '../../src/ai/reframe/camera.ts'
import {
  boxIou,
  decodeDetr,
  preprocessDetr,
  SALIENT_CLASSES,
} from '../../src/ai/reframe/objects.ts'
import {
  candidatesOf,
  planReframe,
  speakingScores,
  strengthParams,
  type Box,
  type Sample,
  type SampleFace,
} from '../../src/ai/reframe/planner.ts'
import { preprocessSaliency, salientBox, SALIENCY_SIZE } from '../../src/ai/reframe/saliency.ts'

const W = 640
const H = 360
const STEP = 333_333 // 3 fps

const person = (cx: number, w = 120, h = 300): Box => ({
  x: cx - w / 2,
  y: 30,
  w,
  h,
  score: 0.9,
})
const faceOf = (p: Box, mouth?: number): SampleFace => {
  const fw = p.w * 0.35
  const f: SampleFace = {
    x: p.x + p.w / 2 - fw / 2,
    y: p.y + 10,
    w: fw,
    h: fw * 1.2,
    score: 0.95,
    landmarks: new Float32Array(10),
  }
  if (mouth !== undefined) {
    f.mouth = new Float32Array(24).fill(mouth)
    f.eyes = new Float32Array(24).fill(0.5)
  }
  return f
}
const sample = (i: number, extra: Partial<Sample>): Sample => ({
  t: i * STEP,
  faces: [],
  ...extra,
})
/** x (as a fraction of the frame) of the planned path at time t. */
const at = (path: ReadonlyArray<{ t: number; x: number; w?: number }>, t: number) => {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    if (t <= b.t) return b.t === a.t ? b.x : a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t)
  }
  return path.at(-1)!.x
}
const opts = { frameWidth: W, frameHeight: H }

describe('planReframe: one subject', () => {
  it('follows a single person (body box) and reports it', () => {
    const samples = Array.from({ length: 30 }, (_, i) => {
      const p = person(200 + i * 8)
      return sample(i, { people: [p], faces: [faceOf(p)] })
    })
    const r = planReframe(samples, { ...opts, strength: 1 })
    expect(r.subjects).toBe(1)
    expect(r.facesFound).toBe(1)
    expect(r.coverage).toBe(1)
    expect(at(r.path, 29 * STEP)).toBeGreaterThan(at(r.path, 0) + 0.15)
    expect(r.path.every((p) => p.w === undefined)).toBe(true)
  })

  it('works from people alone (no face model) and from faces alone (no person model)', () => {
    const body = Array.from({ length: 12 }, (_, i) => sample(i, { people: [person(420)] }))
    expect(at(planReframe(body, opts).path, 5 * STEP)).toBeCloseTo(420 / W, 1)
    const faces = Array.from({ length: 12 }, (_, i) => sample(i, { faces: [faceOf(person(150))] }))
    expect(at(planReframe(faces, opts).path, 5 * STEP)).toBeCloseTo(150 / W, 1)
  })

  it('prefers the large central person over a small one at the edge', () => {
    const samples = Array.from({ length: 15 }, (_, i) =>
      sample(i, { people: [person(320, 200, 330), person(40, 50, 120)] }),
    )
    expect(at(planReframe(samples, opts).path, 7 * STEP)).toBeCloseTo(320 / W, 1)
  })

  it('keeps the camera still for small movements and moves for big ones (strength)', () => {
    const jitter = Array.from({ length: 30 }, (_, i) =>
      sample(i, { people: [person(320 + (i % 2 ? 8 : -8))] }),
    )
    const calm = planReframe(jitter, { ...opts, strength: 0 })
    expect(calm.path.length).toBeLessThanOrEqual(3)
    const walk = Array.from({ length: 30 }, (_, i) => sample(i, { people: [person(150 + i * 12)] }))
    const range = (s: number) => {
      const p = planReframe(walk, { ...opts, strength: s }).path
      return at(p, 29 * STEP) - at(p, 0)
    }
    expect(range(1)).toBeGreaterThan(0.3)
    expect(strengthParams(1).omega).toBeGreaterThan(strengthParams(0).omega)
    expect(strengthParams(0).zone).toBeGreaterThan(strengthParams(1).zone)
    expect(strengthParams(0.5).omega).toBeCloseTo(5, 6)
  })
})

describe('planReframe: several people', () => {
  const pair = (n: number, gap: number, extra: (i: number, a: Box, b: Box) => Partial<Sample>) =>
    Array.from({ length: n }, (_, i) => {
      const a = person(320 - gap / 2)
      const b = person(320 + gap / 2)
      return sample(i, { people: [a, b], faces: [faceOf(a), faceOf(b)], ...extra(i, a, b) })
    })

  it('frames both people when they fit in the (zoomed-out) crop', () => {
    // 9:16 crop of 640x360 is 0.28 of the width; two people 130 px apart span ~0.3.
    const r = planReframe(
      pair(20, 130, () => ({})),
      { ...opts, strength: 1 },
    )
    expect(at(r.path, 10 * STEP)).toBeCloseTo(0.5, 1)
    expect(r.modes.group).toBeGreaterThan(10)
    expect(r.path.some((p) => p.w !== undefined && p.w > 0.28)).toBe(true)
  })

  it('follows the active speaker when the group does not fit', () => {
    // Far apart: the left person's mouth moves while speech is on.
    const samples = pair(30, 480, (i, a) => ({
      speech: 1,
      faces: [
        faceOf(a, i % 2 ? 0.2 : 0.6), // mouth region flickers
        faceOf(person(320 + 240), 0.4), // static mouth
      ],
    }))
    const r = planReframe(samples, { ...opts, strength: 1 })
    expect(r.modes.group).toBe(0)
    expect(at(r.path, 25 * STEP)).toBeLessThan(0.4)
    // Without speech energy nobody is "speaking": no boost, still a valid path.
    const silent = pair(30, 480, (i, a) => ({
      speech: 0,
      faces: [faceOf(a, i % 2 ? 0.2 : 0.6), faceOf(person(560), 0.4)],
    }))
    expect(planReframe(silent, opts).path.length).toBeGreaterThan(0)
  })

  it('never zooms out beyond maxZoomOut', () => {
    const r = planReframe(
      pair(20, 260, () => ({})),
      { ...opts, maxZoomOut: 1 },
    )
    expect(r.modes.group).toBe(0)
    expect(r.path.every((p) => p.w === undefined)).toBe(true)
  })
})

describe('planReframe: shots and fallbacks', () => {
  it('cuts (does not pan) at shot changes and resets the subject', () => {
    const left = Array.from({ length: 10 }, (_, i) => sample(i, { people: [person(120)] }))
    const right = Array.from({ length: 10 }, (_, i) => sample(10 + i, { people: [person(520)] }))
    const cut = 10 * STEP
    const r = planReframe([...left, ...right], { ...opts, cuts: [cut], strength: 0.3 })
    expect(at(r.path, cut - 2)).toBeCloseTo(120 / W, 1)
    expect(at(r.path, cut + 1)).toBeCloseTo(520 / W, 1)
  })

  it('falls back to a salient object, then to the saliency box, then to the centre', () => {
    const dog: Box = { x: 450, y: 150, w: 100, h: 80, score: 0.8 }
    const objects = Array.from({ length: 12 }, (_, i) => sample(i, { objects: [dog] }))
    const o = planReframe(objects, opts)
    expect(at(o.path, 5 * STEP)).toBeCloseTo(500 / W, 1)
    expect(o.modes.object).toBeGreaterThan(8)
    const sal: Box = { x: 80, y: 60, w: 100, h: 100, score: 0.9 }
    const s = planReframe(
      Array.from({ length: 12 }, (_, i) => sample(i, { saliency: sal })),
      opts,
    )
    expect(at(s.path, 5 * STEP)).toBeCloseTo(130 / W, 1)
    expect(s.modes.saliency).toBeGreaterThan(8)
    const c = planReframe(
      Array.from({ length: 12 }, (_, i) => sample(i, {})),
      opts,
    )
    expect(c.modes.centre).toBe(12)
    expect(at(c.path, 5 * STEP)).toBeCloseTo(0.5, 2)
    expect(c.coverage).toBe(0)
  })

  it('ignores a one-sample ghost object and low-confidence saliency', () => {
    const samples = Array.from({ length: 12 }, (_, i) =>
      sample(i, {
        objects: i === 4 ? [{ x: 10, y: 10, w: 50, h: 50, score: 0.9 }] : [],
        saliency: { x: 600, y: 10, w: 30, h: 30, score: 0.1 },
      }),
    )
    const r = planReframe(samples, opts)
    expect(at(r.path, 4 * STEP)).toBeCloseTo(0.5, 2)
  })

  it('returns an empty plan for no samples and keeps planCamera (faces only) working', () => {
    expect(planReframe([], opts).path).toEqual([])
    const f = faceOf(person(500))
    const r = planCamera(
      Array.from({ length: 10 }, (_, i) => ({ t: i * STEP, faces: [f] })),
      opts,
    )
    expect(r.facesFound).toBe(1)
    expect(at(r.path, 5 * STEP)).toBeCloseTo(500 / W, 1)
  })
})

describe('candidates and speaking scores', () => {
  it('attaches the face inside a body box and keeps lone faces', () => {
    const p = person(200)
    const lone = faceOf(person(500))
    const c = candidatesOf(sample(0, { people: [p], faces: [faceOf(p), lone] }))
    expect(c).toHaveLength(2)
    expect(c[0]?.face).toBeDefined()
    expect(c[1]?.box).toBe(lone)
  })

  it('mouth change minus eye change, gated by speech', () => {
    const mk = (m: number, e: number): { face: SampleFace } => ({
      face: {
        ...faceOf(person(100)),
        mouth: new Float32Array(24).fill(m),
        eyes: new Float32Array(24).fill(e),
      },
    })
    const track = { obs: new Map<number, never>() }
    const obs = track.obs as unknown as Map<
      number,
      { face: SampleFace; box: Box; fx: number; left: number; right: number }
    >
    const base = { box: person(100), fx: 100, left: 90, right: 110 }
    obs.set(0, { ...base, ...mk(0.2, 0.5) })
    obs.set(1, { ...base, ...mk(0.6, 0.5) }) // mouth moved, eyes still
    obs.set(2, { ...base, ...mk(0.6, 0.9) }) // head moved: eyes change, mouth not
    const loud = speakingScores(track as never, () => 1, 0)
    expect(loud.get(1)).toBeGreaterThan(0.3)
    expect(loud.get(2) ?? 0).toBe(0)
    expect(speakingScores(track as never, () => 0, 0).get(1)).toBe(0)
  })
})

describe('detector helpers', () => {
  it('decodes DETR outputs: best class per query, scaling, clipping and duplicate merge', () => {
    const classes = 80
    const logits = new Float32Array(3 * classes).fill(-8)
    logits[0 * classes + 0] = 3 // person
    logits[1 * classes + 0] = 2.9 // duplicate person
    logits[2 * classes + 16] = 1 // dog, lower confidence
    const boxes = Float32Array.from([0.5, 0.5, 0.2, 0.4, 0.5, 0.5, 0.2, 0.4, 0.95, 0.5, 0.2, 0.2])
    const d = decodeDetr(logits, boxes, classes, 640, 360, 0.5)
    expect(d.map((x) => x.label)).toEqual([0, 16])
    expect(d[0]!.x).toBeCloseTo(256, 3)
    expect(d[0]!.w).toBeCloseTo(128, 3)
    expect(d[0]!.y).toBeCloseTo(108, 3)
    expect(d[0]!.h).toBeCloseTo(144, 3)
    expect(d[1]!.x + d[1]!.w).toBeLessThanOrEqual(640)
    expect(decodeDetr(logits, boxes, classes, 640, 360, 0.99)).toEqual([])
    expect(SALIENT_CLASSES.has(0)).toBe(false)
    expect(SALIENT_CLASSES.has(16)).toBe(true)
    expect(boxIou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3, 6)
  })

  it('preprocessDetr resamples to a planar 0..1 tensor', () => {
    const rgb = new Uint8Array(4 * 2 * 3)
    for (let i = 0; i < rgb.length; i += 3) rgb.set([255, 0, 128], i)
    const out = new Float32Array(3 * 4 * 4)
    preprocessDetr(rgb, 4, 2, 4, out)
    expect(out[0]).toBeCloseTo(1, 5)
    expect(out[16]).toBeCloseTo(0, 5)
    expect(out[32]).toBeCloseTo(128 / 255, 5)
  })

  it('finds the salient region of a map and rejects empty or all-salient maps', () => {
    const S = 64
    const map = new Float32Array(S * S)
    for (let y = 20; y < 36; y++) for (let x = 40; x < 56; x++) map[y * S + x] = 0.9
    const b = salientBox(map, S, 640, 360)!
    expect(b.x + b.w / 2).toBeCloseTo((48 / S) * 640, -1)
    expect(b.score).toBeCloseTo(0.9, 2)
    expect(salientBox(new Float32Array(S * S), S, 640, 360)).toBeUndefined()
    expect(salientBox(new Float32Array(S * S).fill(1), S, 640, 360)).toBeUndefined()
    const out = new Float32Array(3 * SALIENCY_SIZE * SALIENCY_SIZE)
    preprocessSaliency(new Uint8Array(8 * 8 * 3).fill(255), 8, 8, out)
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 4)
  })

  it('lumaGrid, facePatches and the speech envelope', () => {
    const w = 64
    const h = 64
    const rgb = new Uint8Array(w * h * 3).fill(255)
    const g = lumaGrid(rgb, w, h, 8, 8, 24, 16)!
    expect(g).toHaveLength(24)
    expect(g[0]).toBeCloseTo(1, 3)
    expect(lumaGrid(rgb, w, h, 60, 60, 24, 16)).toBeUndefined()
    const face: SampleFace = {
      x: 16,
      y: 8,
      w: 32,
      h: 40,
      score: 1,
      landmarks: Float32Array.from([24, 20, 40, 20, 32, 30, 26, 40, 38, 40]),
    }
    const p = facePatches(rgb, w, h, face)
    expect(p.mouth).toBeDefined()
    expect(p.eyes).toBeDefined()
    const env = new RmsEnvelope(100)
    env.push(new Float32Array(250).fill(0.5))
    expect(env.values).toEqual([0.5, 0.5])
    const lv = speechLevels([0.001, 0.001, 0.2, 0.25, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3])
    expect(lv[0]).toBeLessThan(0.1)
    expect(lv[9]).toBe(1)
    expect(Math.max(...speechLevels([0, 0, 0]))).toBe(0)
  })
})
