/**
 * Pro timeline edits on the real component with the REAL core ops (no mocks): marquee
 * selection (mouse and two-finger touch), slip (Alt+drag, touch hold), roll edits, ripple
 * trim and cross-track group moves — each one gesture = one undo step.
 *
 * happy-dom: viewport at client (0, 0), 1024 px wide, zoom 100 px/s → client x = 16 +
 * seconds × 100, lanes y = client y − 24 (ruler).
 */
import { Asset, sec, type Project } from '@reelforge/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setEditPref } from '@/editor/editPrefs.ts'
import { clipsInBox } from '@/editor/timeline/hitTest.ts'
import { layoutRows } from '@/editor/timeline/geometry.ts'
import { Timeline } from '@/editor/timeline/index.tsx'
import { editorStore, locateClip } from '@/state/index.ts'
import { clip, mainClips, project, track } from './helpers.ts'

const s = () => editorStore.getState()
const cx = (t: number) => 16 + (t / 1e6) * 100
/** Rows (no markers → no marker row): text (4..34), main (38..94), audio (98..134). */
const Y = { text: 24 + 19, main: 24 + 66 }

const vid = Asset.parse({
  id: 'vid',
  kind: 'video',
  name: 'vid',
  size: 1,
  mime: 'video/mp4',
  createdAt: '2026-01-01T00:00:00.000Z',
  duration: sec(20),
  width: 1080,
  height: 1920,
})

const makeProject = (): Project => {
  const main = mainClips(2, 2, 2)
  main.forEach((c, i) => {
    if (c.type === 'video') c.in = sec(5 * i)
  })
  return project([
    track('main', main, 'main'),
    track(
      'text',
      [clip('text', sec(1), sec(2), { id: 'tx' }), clip('text', sec(4), sec(1), { id: 'ty' })],
      'tt',
    ),
    track('audio', [], 'au'),
  ])
}

const frame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

type P = { id?: number; type?: 'mouse' | 'touch'; alt?: boolean; shift?: boolean }
const viewport = () => screen.getByTestId('timeline-viewport')
const ev = (x: number, y: number, o: P = {}) => ({
  pointerId: o.id ?? 1,
  pointerType: o.type ?? 'mouse',
  button: 0,
  clientX: x,
  clientY: y,
  altKey: o.alt ?? false,
  shiftKey: o.shift ?? false,
})
const down = (x: number, y: number, o: P = {}) => fireEvent.pointerDown(viewport(), ev(x, y, o))
const move = (x: number, y: number, o: P = {}) => fireEvent.pointerMove(viewport(), ev(x, y, o))
const up = (x: number, y: number, o: P = {}) => fireEvent.pointerUp(viewport(), ev(x, y, o))
const drag = (from: [number, number], to: [number, number], o: P = {}) => {
  down(...from, o)
  for (let i = 1; i <= 5; i++)
    move(from[0] + ((to[0] - from[0]) * i) / 5, from[1] + ((to[1] - from[1]) * i) / 5, o)
  up(...to, o)
}
const get = (id: string) => locateClip(s().project, id)!

const mount = async (p: Project = makeProject()) => {
  s().load(p, [vid])
  s().setZoom(100)
  s().setScroll({ x: 0, y: 0 })
  const r = render(<Timeline />)
  await frame()
  return r
}

beforeEach(() => {
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), { vibrate: vi.fn<() => boolean>(() => true) }),
  )
})

afterEach(() => {
  s().unload()
  setEditPref('ripple', false)
  setEditPref('roll', false)
})

describe('clipsInBox', () => {
  it('returns clips on rows the box crosses whose span meets it', () => {
    const p = makeProject()
    const { rows } = layoutRows(p.tracks, false)
    expect(clipsInBox(rows, { t0: sec(0.5), t1: sec(3.5), y0: 30, y1: 80 })).toEqual([
      'tx',
      'm0',
      'm1',
    ])
    expect(clipsInBox(rows, { t0: sec(3.1), t1: sec(3.9), y0: 30, y1: 40 })).toEqual([])
    const locked = project([track('text', [clip('text', 0, sec(1))], 't', { locked: true })])
    expect(
      clipsInBox(layoutRows(locked.tracks, false).rows, { t0: 0, t1: sec(1), y0: 0, y1: 999 }),
    ).toEqual([])
  })
})

describe('marquee selection', () => {
  it('mouse drag on empty lane selects every clip in the box, live', async () => {
    await mount()
    down(cx(sec(3.5)), Y.text)
    move(cx(sec(2)), Y.text + 20)
    move(cx(sec(0.5)), Y.main)
    await frame()
    expect(screen.getByTestId('timeline-marquee').hidden).toBe(false)
    expect([...s().selection.clipIds].sort()).toEqual(['m0', 'm1', 'tx'])
    up(cx(sec(0.5)), Y.main)
    expect(screen.getByTestId('timeline-marquee').hidden).toBe(true)
    expect([...s().selection.clipIds].sort()).toEqual(['m0', 'm1', 'tx'])
    // Shift adds to the existing selection.
    drag([cx(sec(5.5)), Y.text], [cx(sec(4.5)), Y.text + 5], { shift: true })
    expect([...s().selection.clipIds].sort()).toEqual(['m0', 'm1', 'tx', 'ty'])
    expect(s().history.canUndo).toBe(false)
  })

  it('Escape restores the previous selection', async () => {
    await mount()
    s().select(['ty'])
    down(cx(sec(3.5)), Y.text)
    move(cx(sec(0.5)), Y.main)
    fireEvent.keyDown(window, { key: 'Escape' })
    up(cx(sec(0.5)), Y.main)
    expect(s().selection.clipIds).toEqual(['ty'])
  })

  it('two-finger drag at constant distance selects instead of zooming', async () => {
    await mount()
    const t = { type: 'touch' as const }
    // Fingers 300 px apart (midpoint at 1.7 s) move together by (50, 47) px in small steps.
    const ax = cx(sec(0.2))
    down(ax, Y.text, { ...t, id: 1 })
    down(ax + 300, Y.text, { ...t, id: 2 })
    for (let i = 1; i <= 10; i++) {
      move(ax + 5 * i, Y.text + 4.7 * i, { ...t, id: 1 })
      move(ax + 300 + 5 * i, Y.text + 4.7 * i, { ...t, id: 2 })
    }
    up(ax + 350, Y.main, { ...t, id: 2 })
    up(ax + 50, Y.main, { ...t, id: 1 })
    expect(s().zoom).toBe(100)
    expect([...s().selection.clipIds].sort()).toEqual(['m0', 'm1', 'tx'])
  })

  it('two fingers spreading still pinch-zoom', async () => {
    await mount()
    const t = { type: 'touch' as const }
    down(400, Y.main, { ...t, id: 1 })
    down(500, Y.main, { ...t, id: 2 })
    move(350, Y.main, { ...t, id: 1 })
    move(550, Y.main, { ...t, id: 2 })
    await frame()
    up(550, Y.main, { ...t, id: 2 })
    up(350, Y.main, { ...t, id: 1 })
    expect(s().zoom).toBeCloseTo(200)
    expect(s().selection.clipIds).toEqual([])
  })
})

describe('slip', () => {
  it('Alt+drag moves the content inside the fixed span (one undo step)', async () => {
    await mount()
    drag([cx(sec(3)), Y.main], [cx(sec(2.5)), Y.main], { alt: true })
    const c = get('m1').clip
    expect(c.type === 'video' && c.in).toBe(sec(5.5))
    expect(c.start).toBe(sec(2))
    expect(c.duration).toBe(sec(2))
    expect(s().history.undoLabel).toBe('Slip clip')
    s().undo()
    expect(get('m1').clip.type === 'video' && (get('m1').clip as { in: number }).in).toBe(sec(5))
  })

  it('shows the source ghost while slipping and clamps at the source start', async () => {
    await mount()
    down(cx(sec(1)), Y.main, { alt: true })
    move(cx(sec(4)), Y.main, { alt: true })
    await frame()
    expect(screen.getByTestId('slip-ghost').hidden).toBe(false)
    expect(screen.getByTestId('drag-badge').textContent).toBe('Slip +0.00s')
    up(cx(sec(4)), Y.main, { alt: true })
    expect(screen.getByTestId('slip-ghost').hidden).toBe(true)
    // m0 starts at source 0: nothing earlier to reveal.
    expect(s().history.canUndo).toBe(false)
  })

  it('touch: holding past the lift slips instead of moving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await mount()
      const t = { type: 'touch' as const }
      down(cx(sec(3)), Y.main, t)
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
      for (let i = 1; i <= 4; i++) move(cx(sec(3)) - 12.5 * i, Y.main, t)
      up(cx(sec(2.5)), Y.main, t)
      const c = get('m1').clip
      expect(c.type === 'video' && c.in).toBe(sec(5.5))
      expect(s().history.undoLabel).toBe('Slip clip')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('roll', () => {
  it('Roll mode: dragging a main cut trims both clips, nothing else moves', async () => {
    await mount()
    setEditPref('roll', true)
    drag([cx(sec(2)) + 2, Y.main], [cx(sec(2.5)) + 2, Y.main])
    expect(get('m0').clip.duration).toBe(sec(2.5))
    expect(get('m1').clip.duration).toBe(sec(1.5))
    expect(get('m1').clip.type === 'video' && (get('m1').clip as { in: number }).in).toBe(sec(5.5))
    expect(get('m2').clip.start).toBe(sec(4))
    expect(s().history.undoLabel).toBe('Roll edit')
  })

  it('Alt+drag on a cut rolls without the mode', async () => {
    await mount()
    drag([cx(sec(4)) - 2, Y.main], [cx(sec(3.5)) - 2, Y.main], { alt: true })
    expect(get('m1').clip.duration).toBe(sec(1.5))
    expect(get('m2').clip.duration).toBe(sec(2.5))
  })

  it('without Alt or the mode a cut drag is a normal (rippling) trim', async () => {
    await mount()
    drag([cx(sec(2)) - 2, Y.main], [cx(sec(2.5)) - 2, Y.main])
    expect(get('m0').clip.duration).toBe(sec(2.5))
    expect(get('m1').clip.duration).toBe(sec(2))
    expect(get('m2').clip.start).toBe(sec(4.5))
  })
})

describe('ripple trim', () => {
  it('Ripple mode shifts later clips on the same track', async () => {
    await mount()
    setEditPref('ripple', true)
    drag([cx(sec(3)) - 2, Y.text], [cx(sec(3.5)) - 2, Y.text])
    expect(get('tx').clip.duration).toBe(sec(2.5))
    expect(get('ty').clip.start).toBe(sec(4.5))
    expect(s().history.undoLabel).toBe('Ripple trim')
  })

  it('off: the next clip limits the trim', async () => {
    await mount()
    drag([cx(sec(3)) - 2, Y.text], [cx(sec(4.5)) - 2, Y.text])
    expect(get('tx').clip.duration).toBe(sec(3))
    expect(get('ty').clip.start).toBe(sec(4))
  })
})

describe('group moves', () => {
  it('moves a multi-selection across tracks by the same number of rows', async () => {
    const p = project([
      track('main', mainClips(1, 1, 1, 1, 1, 1), 'main'),
      track('text', [], 't1'),
      track('text', [clip('text', sec(2), sec(1), { id: 'b' })], 't2'),
      track('text', [clip('text', sec(1), sec(1), { id: 'a' })], 't3'),
    ])
    await mount(p)
    s().select(['a', 'b'])
    // Rows top → bottom: t3 (4..34), t2 (38..68), t1 (72..102), main.
    drag([cx(sec(1.5)), 24 + 19], [cx(sec(1.5)), 24 + 53])
    expect(get('a').track.id).toBe('t2')
    expect(get('b').track.id).toBe('t1')
    expect(get('a').clip.start).toBe(sec(1))
    expect(s().history.undoLabel).toBe('Move 2 clips')
    s().undo()
    expect(get('a').track.id).toBe('t3')
  })

  it('snaps any member edge (magnetic groups)', async () => {
    const p = project([
      track('main', mainClips(1, 1, 1, 1, 1, 1), 'main'),
      track(
        'text',
        [clip('text', sec(1), sec(1), { id: 'a' }), clip('text', sec(3), sec(0.5), { id: 'b' })],
        't1',
      ),
    ])
    await mount(p)
    s().select(['a', 'b'])
    // b's end (3.5 s) is dragged to 3.95 s → snaps to the m3/m4 cut at 4 s.
    drag([cx(sec(1.5)), Y.text], [cx(sec(1.95)), Y.text])
    expect(get('b').clip.start + get('b').clip.duration).toBe(sec(4))
    expect(get('a').clip.start).toBe(sec(1.5))
  })
})
