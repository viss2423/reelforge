import { describe, expect, it } from 'vitest'
import {
  OpError,
  addTrack,
  applyReframe,
  evaluate,
  insertMediaClip,
  insertTextClip,
  validateProject,
} from '../src/index.ts'
import { asset, project, projectWithMain } from './helpers.ts'

const SEC = 1_000_000
// 1920×1080 under fit 'cover' on 1080×1920: scale 1920/1080 → displayed width 3413.33 px.
const W = (1920 * 1920) / 1080
const MAX_X = W / 2
const MIN_X = 1080 - W / 2

describe('applyReframe', () => {
  it('centres the subject and clamps so cover never shows borders', () => {
    const { p, clips } = projectWithMain([4 * SEC])
    const c = clips[0]!
    applyReframe(p, c.id, [
      { t: 0, x: 0.5 },
      { t: 2 * SEC, x: 0.6 },
      { t: 4 * SEC, x: 0 },
    ])
    expect(evaluate(c.transform.x, 0)).toBeCloseTo(540, 1)
    expect(evaluate(c.transform.x, 2 * SEC)).toBeCloseTo(540 - 0.1 * W, 1)
    expect(evaluate(c.transform.x, 4 * SEC)).toBeCloseTo(MAX_X, 1)
    for (const k of c.transform.x.keyframes) {
      expect(k.value).toBeLessThanOrEqual(MAX_X + 0.01)
      expect(k.value).toBeGreaterThanOrEqual(MIN_X - 0.01)
      expect(k.easing).toBe('linear')
    }
    expect(validateProject(p)).toEqual([])
  })

  it('a constant subject yields a static position without keyframes', () => {
    const { p, clips } = projectWithMain([2 * SEC])
    applyReframe(p, clips[0]!.id, [{ t: 0, x: 0.75 }])
    expect(clips[0]!.transform.x.keyframes).toEqual([])
    expect(clips[0]!.transform.x.value).toBeCloseTo(540 - 0.25 * W, 1)
  })

  it('maps SOURCE times through in-point and speed', () => {
    const { p, clips } = projectWithMain([2 * SEC])
    const c = clips[0]!
    c.in = 2 * SEC
    c.speed = 2
    applyReframe(p, c.id, [
      { t: 2 * SEC, x: 0.5 },
      { t: 6 * SEC, x: 0.6 },
    ])
    // Source 6 s is clip time 2 s; source 4 s (x = 0.55) is clip time 1 s.
    expect(evaluate(c.transform.x, SEC)).toBeCloseTo(540 - 0.05 * W, 0)
    expect(evaluate(c.transform.x, 2 * SEC)).toBeCloseTo(540 - 0.1 * W, 0)
  })

  it('simplifies dense detector output to few keyframes', () => {
    const { p, clips } = projectWithMain([10 * SEC])
    const path = Array.from({ length: 301 }, (_, i) => ({
      t: (i * 10 * SEC) / 300,
      x: 0.4 + (0.2 * i) / 300,
    }))
    applyReframe(p, clips[0]!.id, path)
    const kfs = clips[0]!.transform.x.keyframes
    expect(kfs.length).toBeLessThanOrEqual(3)
    expect(evaluate(clips[0]!.transform.x, 5 * SEC)).toBeCloseTo(540, 0)
  })

  it('honours flipH, crop, rotation metadata and contain (no clamping)', () => {
    const { p, clips } = projectWithMain([SEC])
    const c = clips[0]!
    c.transform.flipH = true
    applyReframe(p, c.id, [{ t: 0, x: 0.6 }])
    expect(c.transform.x.value).toBeCloseTo(540 + 0.1 * W, 1)

    c.transform.flipH = false
    c.crop.left = 0.25
    c.crop.right = 0.25
    // Cropped 960×1080 → cover scale 1920/1080 → width 1706.67; subject 0.5 is the crop centre.
    applyReframe(p, c.id, [{ t: 0, x: 0.5 }])
    expect(c.transform.x.value).toBeCloseTo(540, 1)

    c.crop.left = 0
    c.crop.right = 0
    c.fit = 'contain'
    // Rotated portrait 1080×1920 contained → width 1080; subject at 0 → centre at 1080.
    applyReframe(p, c.id, [{ t: 0, x: 0 }], { width: 1920, height: 1080, rotation: 90 })
    expect(c.transform.x.value).toBeCloseTo(1080, 1)
  })

  it('works on overlay image clips and validates input', () => {
    const p = project()
    const overlay = addTrack(p, 'overlay')
    const img = insertMediaClip(p, { trackId: overlay.id, asset: asset({ kind: 'image' }), at: 0 })
    applyReframe(p, img.id, [
      { t: 0, x: 0.5 },
      { t: 3 * SEC, x: 0.6 },
      { t: Number.NaN, x: 0.1 },
    ])
    expect(img.transform.x.keyframes.length).toBeGreaterThan(1)
    const text = insertTextClip(p, { at: 0, text: 'x' })
    expect(() => applyReframe(p, text.id, [{ t: 0, x: 0.5 }])).toThrow(OpError)
    expect(() => applyReframe(p, img.id, [])).toThrow(/empty/)
  })

  it('zooms out to keep a wide group in frame and back in when it narrows', () => {
    const { p, clips } = projectWithMain([4 * SEC])
    const c = clips[0]!
    const shown = 1080 / W // fraction of the source width the 9:16 frame shows at scale 1
    applyReframe(p, c.id, [
      { t: 0, x: 0.5 },
      { t: 2 * SEC, x: 0.5, w: 1.5 * shown },
      { t: 4 * SEC, x: 0.5 },
    ])
    expect(evaluate(c.transform.scale, 0)).toBeCloseTo(1, 3)
    expect(evaluate(c.transform.scale, 2 * SEC)).toBeCloseTo(1 / 1.5, 3)
    expect(evaluate(c.transform.scale, 4 * SEC)).toBeCloseTo(1, 3)
    // Centred subject stays centred while zoomed (the canvas centre).
    expect(evaluate(c.transform.x, 2 * SEC)).toBeCloseTo(540, 1)
    expect(validateProject(p)).toEqual([])
  })

  it('never zooms below half the clip scale and leaves scale alone without widths', () => {
    const { p, clips } = projectWithMain([2 * SEC])
    const c = clips[0]!
    c.transform.scale = { value: 1.2, keyframes: [] }
    applyReframe(p, c.id, [{ t: 0, x: 0.5, w: 1 }])
    expect(evaluate(c.transform.scale, 0)).toBeCloseTo(0.6, 3)
    const { p: q, clips: d } = projectWithMain([2 * SEC])
    applyReframe(q, d[0]!.id, [{ t: 0, x: 0.3 }])
    expect(d[0]!.transform.scale).toEqual({ value: 1, keyframes: [] })
  })
})
