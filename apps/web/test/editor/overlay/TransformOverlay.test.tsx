/**
 * On-canvas transform overlay, driven by synthetic Pointer Events on the real component and
 * the global editor store: selection, move with snapping, corner scale, rotate handle,
 * two-finger pinch/twist, keyframe-aware writes, one undo step per gesture, Escape, locked
 * tracks, crop mode and inline text editing.
 *
 * The overlay is 270×480 CSS px, so client px = canvas px × 0.25 (happy-dom puts the box at
 * client 0,0).
 */
import { Asset, sec, type Project } from '@reelforge/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribePreviewOverride } from '@/editor/viewer/previewOverride.ts'
import { TransformOverlay } from '@/editor/viewer/overlay/TransformOverlay.tsx'
import { editorStore, locateClip } from '@/state/index.ts'
import { clip, project, track } from '../timeline/helpers.ts'

const s = () => editorStore.getState()
const K = 0.25
const tall = Asset.parse({
  id: 'tall',
  kind: 'video',
  name: 'tall',
  size: 1,
  mime: 'video/mp4',
  createdAt: '2026-01-01T00:00:00.000Z',
  duration: sec(10),
  width: 1080,
  height: 1920,
})

/** Main video (full canvas), a 512 px sticker at the centre and a text clip near the top. */
const makeProject = (o: { sticker?: Record<string, unknown>; locked?: boolean } = {}): Project =>
  project([
    track('main', [clip('video', 0, sec(4), { id: 'm0', assetId: 'tall' })], 'main'),
    track('overlay', [clip('sticker', 0, sec(4), { id: 'st', ...o.sticker })], 'ov', {
      locked: o.locked ?? false,
    }),
    track(
      'text',
      [clip('text', 0, sec(4), { id: 'tx', text: 'Hello', transform: { y: { value: 300 } } })],
      'tx',
    ),
  ])

const frame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

type P = { id?: number; type?: 'mouse' | 'touch' }
const root = () => screen.getByTestId('transform-overlay')
const ev = (x: number, y: number, o: P = {}) => ({
  pointerId: o.id ?? 1,
  pointerType: o.type ?? 'mouse',
  button: 0,
  clientX: x * K,
  clientY: y * K,
})
const down = (x: number, y: number, o: P = {}, el: Element = root()) =>
  fireEvent.pointerDown(el, ev(x, y, o))
const move = (x: number, y: number, o: P = {}) => fireEvent.pointerMove(root(), ev(x, y, o))
const up = (x: number, y: number, o: P = {}) => fireEvent.pointerUp(root(), ev(x, y, o))
const drag = (from: [number, number], to: [number, number], o: P = {}, el?: Element) => {
  down(...from, o, el)
  for (let i = 1; i <= 4; i++)
    move(from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4, o)
  up(...to, o)
}
const clipOf = (id: string) => {
  const c = locateClip(s().project, id)!.clip
  if (c.type === 'audio') throw new Error('not visual')
  return c
}

let vibrate: ReturnType<typeof vi.fn<(p: VibratePattern) => boolean>>

const mount = async (p: Project = makeProject()) => {
  s().load(p, [tall])
  s().setPlayhead(sec(1))
  const r = render(<TransformOverlay width={270} height={480} />)
  await frame()
  return r
}

beforeEach(() => {
  vibrate = vi.fn<(p: VibratePattern) => boolean>(() => true)
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { vibrate }))
})

afterEach(() => {
  s().unload()
})

describe('selection', () => {
  it('selects the top-most clip under a tap and frames it', async () => {
    await mount()
    down(540, 960)
    up(540, 960)
    expect(s().selection.clipIds).toEqual(['st'])
    await frame()
    const f = screen.getByTestId('transform-frame')
    expect(f.hidden).toBe(false)
    expect(f.dataset.clipId).toBe('st')
    expect(f.style.width).toBe(`${512 * K}px`)
    // Outside the sticker the main video is hit; text is drawn above everything.
    down(100, 1800)
    up(100, 1800)
    expect(s().selection.clipIds).toEqual(['m0'])
    down(540, 300)
    up(540, 300)
    expect(s().selection.clipIds).toEqual(['tx'])
  })

  it('clears the selection on an empty tap', async () => {
    await mount(
      project([
        track('main', [], 'main'),
        track('overlay', [clip('sticker', 0, sec(4), { id: 'st' })], 'ov'),
      ]),
    )
    s().select(['st'])
    down(50, 50)
    up(50, 50)
    expect(s().selection.clipIds).toEqual([])
  })
})

describe('move', () => {
  it('previews without touching the store and commits ONE undo step', async () => {
    await mount()
    const overrides: Array<Project | null> = []
    const off = subscribePreviewOverride((p) => overrides.push(p))
    const before = s().project
    down(540, 960)
    move(580, 1050)
    move(600, 1100)
    await frame()
    expect(s().project).toBe(before)
    const live = overrides.at(-1)!
    expect(locateClip(live, 'st')!.clip).toMatchObject({ transform: { x: { value: 600 } } })
    up(600, 1100)
    off()
    expect(overrides.at(-1)).toBeNull()
    expect(clipOf('st').transform.x.value).toBe(600)
    expect(clipOf('st').transform.y.value).toBe(1100)
    expect(s().history.undoLabel).toBe('Move')
    s().undo()
    expect(clipOf('st').transform.x.value).toBe(540)
    expect(s().history.canUndo).toBe(false)
  })

  it('does not re-render React while dragging', async () => {
    s().load(makeProject(), [tall])
    s().setPlayhead(sec(1))
    let renders = 0
    render(
      <Profiler id="ov" onRender={() => renders++}>
        <TransformOverlay width={270} height={480} />
      </Profiler>,
    )
    await frame()
    down(540, 960)
    move(560, 980)
    await frame()
    const before = renders
    for (let i = 0; i < 20; i++) {
      move(560 + i * 5, 980 + i * 3)
      await frame()
    }
    expect(renders).toBe(before)
    up(655, 1037)
  })

  it('snaps to the canvas centre with a haptic tick (Alt disables)', async () => {
    await mount(makeProject({ sticker: { transform: { x: { value: 300 } } } }))
    drag([300, 960], [536, 960])
    expect(clipOf('st').transform.x.value).toBe(540)
    expect(vibrate).toHaveBeenCalled()
    down(540, 960)
    fireEvent.pointerMove(root(), { ...ev(560, 960), altKey: true })
    fireEvent.pointerUp(root(), { ...ev(560, 960), altKey: true })
    expect(clipOf('st').transform.x.value).toBe(560)
  })

  it('writes a keyframe at the playhead when the property is animated', async () => {
    await mount(
      makeProject({
        sticker: {
          transform: {
            x: {
              value: 540,
              keyframes: [
                { t: 0, value: 540, easing: 'linear' },
                { t: sec(4), value: 540, easing: 'linear' },
              ],
            },
          },
        },
      }),
    )
    drag([540, 960], [740, 1100], {})
    const tr = clipOf('st').transform
    expect(tr.x.keyframes.map((k) => [k.t, k.value])).toEqual([
      [0, 540],
      [sec(1), 740],
      [sec(4), 540],
    ])
    // y had no keyframes: its constant value changed instead.
    expect(tr.y.value).toBe(1100)
  })

  it('ignores clips on locked tracks', async () => {
    await mount(makeProject({ locked: true }))
    drag([540, 960], [700, 960])
    expect(clipOf('st').transform.x.value).toBe(540)
    expect(s().history.canUndo).toBe(false)
  })

  it('Escape cancels the gesture', async () => {
    await mount()
    down(540, 960)
    move(700, 960)
    fireEvent.keyDown(window, { key: 'Escape' })
    up(700, 960)
    expect(clipOf('st').transform.x.value).toBe(540)
    expect(s().history.canUndo).toBe(false)
  })
})

describe('scale and rotate', () => {
  it('scales from a corner handle about the centre', async () => {
    await mount()
    s().select(['st'])
    await frame()
    drag([796, 1216], [1052, 1472], {}, screen.getByTestId('handle-se'))
    expect(clipOf('st').transform.scale.value).toBeCloseTo(2, 3)
    expect(clipOf('st').transform.x.value).toBe(540)
    expect(s().history.undoLabel).toBe('Scale')
  })

  it('rotates with the rotate handle and snaps to right angles', async () => {
    await mount()
    s().select(['st'])
    await frame()
    drag([540, 600], [900, 970], {}, screen.getByTestId('handle-rot'))
    expect(clipOf('st').transform.rotation.value).toBe(90)
    expect(s().history.undoLabel).toBe('Rotate')
  })

  it('pinches and twists with two fingers in one step', async () => {
    await mount()
    const t = { type: 'touch' as const }
    down(500, 960, { ...t, id: 1 })
    down(580, 960, { ...t, id: 2 })
    // Spread ×2.5 and turn 30° (both fingers around the midpoint).
    const r = 100
    const a = (30 * Math.PI) / 180
    move(540 - r * Math.cos(a), 960 - r * Math.sin(a), { ...t, id: 1 })
    move(540 + r * Math.cos(a), 960 + r * Math.sin(a), { ...t, id: 2 })
    up(540 + r * Math.cos(a), 960 + r * Math.sin(a), { ...t, id: 2 })
    up(540 - r * Math.cos(a), 960 - r * Math.sin(a), { ...t, id: 1 })
    const tr = clipOf('st').transform
    expect(tr.scale.value).toBeCloseTo(2.5, 2)
    expect(tr.rotation.value).toBeCloseTo(30, 1)
    expect(tr.x.value).toBeCloseTo(540, 0)
    expect(s().history.undoLabel).toBe('Transform')
  })
})

describe('crop mode', () => {
  it('drags a crop edge over the whole source frame', async () => {
    await mount()
    s().select(['m0'])
    await frame()
    fireEvent.click(screen.getByTestId('crop-toggle'))
    await frame()
    expect(screen.getByTestId('crop-frame').hidden).toBe(false)
    drag([0, 960], [270, 960], {}, screen.getByTestId('crop-left'))
    const c = locateClip(s().project, 'm0')!.clip
    expect(c.type === 'video' && c.crop.left).toBeCloseTo(0.25, 3)
    expect(s().history.undoLabel).toBe('Crop')
  })
})

describe('inline text editing', () => {
  it('opens on a double tap and commits ONE edit on blur', async () => {
    await mount()
    for (let i = 0; i < 2; i++) {
      down(540, 300)
      up(540, 300)
    }
    const editor = (await screen.findByTestId('inline-text-editor')) as HTMLTextAreaElement
    expect(editor.value).toBe('Hello')
    fireEvent.change(editor, { target: { value: 'Hi there' } })
    fireEvent.blur(editor)
    expect(screen.queryByTestId('inline-text-editor')).toBeNull()
    const c = locateClip(s().project, 'tx')!.clip
    expect(c.type === 'text' && c.text).toBe('Hi there')
    expect(s().history.undoLabel).toBe('Edit text')
  })

  it('Escape cancels the edit', async () => {
    await mount()
    for (let i = 0; i < 2; i++) {
      down(540, 300)
      up(540, 300)
    }
    const editor = await screen.findByTestId('inline-text-editor')
    fireEvent.change(editor, { target: { value: 'nope' } })
    fireEvent.keyDown(editor, { key: 'Escape' })
    const c = locateClip(s().project, 'tx')!.clip
    expect(c.type === 'text' && c.text).toBe('Hello')
  })
})
