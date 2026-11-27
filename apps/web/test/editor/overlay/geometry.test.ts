/**
 * On-canvas geometry: visibility/draw order, poses (matching the compositor), hit testing,
 * gesture maths, snapping and crop handles.
 */
import { Asset, sec } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import {
  bounds,
  contains,
  cornerScale,
  corners,
  dragCrop,
  frameUV,
  fullFrame,
  normAngle,
  pinchDelta,
  poseOf,
  snapAngle,
  snapMove,
  snapScale,
  textBlockSize,
  topmostAt,
  visibleAt,
  type Pose,
} from '@/editor/viewer/overlay/geometry.ts'
import { clip, mainClips, project, track } from '../timeline/helpers.ts'

const asset = (id: string, width: number, height: number, rotation?: number) =>
  Asset.parse({
    id,
    kind: 'video',
    name: id,
    size: 1,
    mime: 'video/mp4',
    createdAt: '2026-01-01T00:00:00.000Z',
    duration: sec(10),
    width,
    height,
    rotation,
  })

const assets = {
  vid: asset('vid', 1920, 1080),
  tall: asset('tall', 1080, 1920),
  rot: asset('rot', 1920, 1080, -90),
}

const pose = (o: Partial<Pose> = {}): Pose => ({
  cx: 540,
  cy: 960,
  w: 200,
  h: 100,
  rotation: 0,
  flipH: false,
  flipV: false,
  ...o,
})

describe('visibleAt', () => {
  it('lists main, overlay and text clips at t bottom → top, text last', () => {
    const p = project([
      track('main', mainClips(2, 2), 'main'),
      track('text', [clip('text', 0, sec(5), { id: 't' })], 'tx'),
      track('overlay', [clip('image', sec(1), sec(2), { id: 'o' })], 'ov'),
      track('audio', [clip('audio', 0, sec(5))], 'au'),
    ])
    expect(visibleAt(p, sec(1.5)).map((x) => x.clip.id)).toEqual(['m0', 'o', 't'])
    const at3 = visibleAt(p, sec(3))
    expect(at3.map((x) => [x.clip.id, x.local])).toEqual([
      ['m1', sec(1)],
      ['t', sec(3)],
    ])
  })

  it('skips hidden tracks and uses overlap-adjusted main starts', () => {
    const p = project([
      track(
        'main',
        [
          clip('video', 0, sec(2), { id: 'a' }),
          clip('video', sec(2), sec(2), {
            id: 'b',
            transitionIn: { type: 'fade', duration: sec(0.5) },
          }),
        ],
        'main',
      ),
      track('overlay', [clip('image', 0, sec(4), { id: 'o' })], 'ov', { hidden: true }),
    ])
    // b starts at 1.5 s in playback time; both are visible during the transition.
    expect(visibleAt(p, sec(1.6)).map((x) => [x.clip.id, x.local])).toEqual([
      ['a', sec(1.6)],
      ['b', sec(0.1)],
    ])
  })
})

describe('poseOf', () => {
  it('cover-fits landscape media to the canvas height', () => {
    const c = clip('video', 0, sec(1), { assetId: 'vid' })
    const p = poseOf({ clip: c as never, local: 0 }, assets)
    expect(p.cx).toBeCloseTo(540)
    expect(p.cy).toBeCloseTo(960)
    expect(p.h).toBeCloseTo(1920)
    expect(p.w).toBeCloseTo(1920 * (1920 / 1080))
  })

  it('applies transform keyframes, scale, rotation and display rotation', () => {
    const c = clip('video', 0, sec(2), {
      assetId: 'rot',
      fit: 'contain',
      transform: {
        x: {
          value: 0,
          keyframes: [
            { t: 0, value: 100, easing: 'linear' },
            { t: sec(2), value: 300, easing: 'linear' },
          ],
        },
        scale: { value: 0.5 },
        rotation: { value: 30 },
      },
    })
    const p = poseOf({ clip: c as never, local: sec(1) }, assets)
    expect(p.cx).toBeCloseTo(200)
    // -90° metadata → displayed portrait 1080×1920: contain = the whole canvas, × 0.5.
    expect(p.w).toBeCloseTo(540)
    expect(p.h).toBeCloseTo(960)
    expect(p.rotation).toBeCloseTo(30)
  })

  it('keeps the rotation of flipped clips', () => {
    const c = clip('video', 0, sec(1), {
      assetId: 'tall',
      transform: { rotation: { value: -45 }, flipH: true },
    })
    expect(poseOf({ clip: c as never, local: 0 }, assets).rotation).toBeCloseTo(-45)
  })

  it('sizes text from the layout estimate and scale', () => {
    const t = clip('text', 0, sec(1), { text: 'Hello', transform: { scale: { value: 2 } } })
    const size = textBlockSize(t as never)
    const p = poseOf({ clip: t as never, local: 0 }, assets)
    expect(p.w).toBeCloseTo(size.width * 2)
    expect(p.h).toBeCloseTo(size.height * 2)
    const two = textBlockSize(clip('text', 0, 1, { text: 'a\nb' }) as never)
    expect(two.height).toBeGreaterThan(size.height)
  })
})

describe('hit testing', () => {
  it('handles rotation and slop', () => {
    const p = pose({ rotation: 90 })
    expect(contains(p, 540, 960 + 90)).toBe(true)
    expect(contains(p, 540 + 90, 960)).toBe(false)
    expect(contains(p, 540 + 55, 960, 10)).toBe(true)
    const b = bounds(p)
    expect(b.x1 - b.x0).toBeCloseTo(100)
    expect(corners(pose())[0]).toEqual([440, 910])
  })

  it('prefers exact hits on the top-most item over slop hits', () => {
    const big = { id: 'big', pose: pose({ w: 1080, h: 1920 }) }
    const small = { id: 'small', pose: pose({ cx: 100, cy: 100, w: 50, h: 50 }) }
    expect(topmostAt([big, small], 100, 100)?.id).toBe('small')
    expect(topmostAt([big, small], 130, 100, 10)?.id).toBe('big')
    expect(topmostAt([small], 130, 100, 10)?.id).toBe('small')
    expect(topmostAt([small], 300, 300, 10)).toBeUndefined()
  })
})

describe('gesture maths', () => {
  it('computes two-finger translate / scale / twist', () => {
    const d = pinchDelta([0, 0], [100, 0], [10, 10], [10, 210])
    expect(d.dx).toBeCloseTo(-40)
    expect(d.dy).toBeCloseTo(110)
    expect(d.scale).toBeCloseTo(2)
    expect(d.rotation).toBeCloseTo(90)
  })

  it('scales corners about the centre and snaps scale and angles', () => {
    expect(cornerScale(0, 0, 10, 0, 0, 30)).toBeCloseTo(3)
    expect(snapScale(1.02)).toEqual({ value: 1, snapped: true })
    expect(snapScale(1.2).snapped).toBe(false)
    expect(snapAngle(88)).toEqual({ value: 90, snapped: true })
    expect(snapAngle(80)).toEqual({ value: 80, snapped: false })
    expect(snapAngle(-178)).toEqual({ value: 180, snapped: true })
    expect(snapAngle(37, { step: 15 }).value).toBe(30)
    expect(normAngle(270)).toBe(-90)
    expect(normAngle(-180)).toBe(180)
  })

  it('snaps a moved box to the centre, edges and safe zones', () => {
    const p = pose({ cx: 300, cy: 300 })
    // Centre x 300 + 236 = 536 → snaps to 540.
    const c = snapMove(p, 236, 0, 8)
    expect(c.dx).toBe(240)
    expect(c.guides).toEqual([{ axis: 'x', at: 540, kind: 'center' }])
    // Left edge 200 − 195 = 5 → canvas edge 0.
    const e = snapMove(p, -195, 0, 8)
    expect(e.dx).toBe(-200)
    // Top edge 250 − 33 = 217 → safe top 220; and both axes at once.
    const s = snapMove(p, 236, -33, 8)
    expect(s.dy).toBe(-30)
    expect(s.guides.map((g) => g.kind)).toEqual(['center', 'safe'])
    expect(snapMove(p, 100, 100, 8).guides).toEqual([])
  })
})

describe('crop', () => {
  const crop = { left: 0.1, top: 0.2, right: 0.3, bottom: 0 }

  it('poses the full frame around the crop window', () => {
    const window = pose({ w: 600, h: 800 })
    const full = fullFrame(window, crop)
    expect(full.w).toBeCloseTo(1000)
    expect(full.h).toBeCloseTo(1000)
    // Window spans u 0.1..0.7: its centre (0.4) is 0.1 left of the frame centre.
    expect(full.cx).toBeCloseTo(540 + 100)
    expect(full.cy).toBeCloseTo(960 - 100)
    const [u, v] = frameUV(full, window.cx, window.cy)
    expect(u).toBeCloseTo(0.4)
    expect(v).toBeCloseTo(0.6)
  })

  it('mirrors under flips and rotation', () => {
    const window = pose({ w: 600, h: 800, flipH: true, rotation: 90 })
    const full = fullFrame(window, crop)
    const [u] = frameUV(full, window.cx, window.cy)
    expect(u).toBeCloseTo(0.4)
  })

  it('drags sides and corners, keeping 5 % visible', () => {
    const full = pose({ w: 1000, h: 1000 })
    const left = 540 - 500
    const top = 960 - 500
    expect(dragCrop(full, crop, ['left'], left + 250, 0).left).toBeCloseTo(0.25)
    expect(dragCrop(full, crop, ['right', 'bottom'], left + 900, top + 800)).toMatchObject({
      right: expect.closeTo(0.1, 5),
      bottom: expect.closeTo(0.2, 5),
    })
    expect(dragCrop(full, crop, ['left'], left + 2000, 0).left).toBeCloseTo(0.65)
    expect(dragCrop(full, crop, ['top'], 0, top - 300).top).toBe(0)
  })
})
