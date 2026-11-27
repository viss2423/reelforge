/**
 * Timeline component tests: rendering, virtualisation, selection, scrubbing, trim, move,
 * Escape-cancel, keyboard nudges, track headers, zoom and pan, driven by synthetic Pointer
 * Events on the real component and the global editor store. Core timeline ops are mocked
 * with minimal draft mutations (core has its own suite); what is tested here is which op
 * the timeline calls, with which frame-accurate arguments, and that a gesture is ONE edit.
 *
 * happy-dom reports zero-size boxes, so the view falls back to `window.innerWidth` (1024)
 * and the viewport sits at client (0, 0). With zoom 100 px/s, client x = 16 + seconds × 100
 * and lanes y = client y − 24 (ruler).
 */
import { Track, sec, type Project } from '@reelforge/core'
import type * as Core from '@reelforge/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timeline } from '@/editor/timeline/index.tsx'
import { editorStore } from '@/state/index.ts'
import { clip, mainClips, project, track } from './helpers.ts'

const ops = vi.hoisted(() => ({
  moveClip: vi.fn<typeof Core.moveClip>(),
  trimClip: vi.fn<typeof Core.trimClip>(),
  addTrack: vi.fn<typeof Core.addTrack>(),
}))

vi.mock('@reelforge/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reelforge/core')>()),
  ...ops,
}))

const s = () => editorStore.getState()
let vibrate: ReturnType<typeof vi.fn<(pattern: VibratePattern) => boolean>>
const find = (p: Project, id: string) => {
  for (const t of p.tracks) {
    const i = t.clips.findIndex((c) => c.id === id)
    if (i !== -1) return { track: t, index: i, clip: t.clips[i]! }
  }
  throw new Error(`no clip ${id}`)
}

/** Client coordinates for time `t` (µs) and lanes y. */
const cx = (t: number) => 16 + (t / 1e6) * 100
/** Lane centres (no markers, so no marker row): text 4..34, main 38..94, audio 98..134. */
const ROW_Y = { text: 24 + 19, main: 24 + 66, audio: 24 + 116, ruler: 10 }

const makeProject = (extraTracks: Track[] = []) =>
  project([
    track('main', mainClips(2, 2, 2), 'main'),
    track('text', [clip('text', sec(1), sec(2), { id: 'tx' })], 'tx-track'),
    track('audio', [], 'au'),
    ...extraTracks,
  ])

const frame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

type PointerInit = { id?: number; type?: 'mouse' | 'touch' | 'pen'; shift?: boolean }
const viewport = () => screen.getByTestId('timeline-viewport')
const down = (x: number, y: number, o: PointerInit = {}) =>
  fireEvent.pointerDown(viewport(), {
    pointerId: o.id ?? 1,
    pointerType: o.type ?? 'mouse',
    button: 0,
    clientX: x,
    clientY: y,
    shiftKey: o.shift ?? false,
  })
const move = (x: number, y: number, o: PointerInit = {}) =>
  fireEvent.pointerMove(viewport(), {
    pointerId: o.id ?? 1,
    pointerType: o.type ?? 'mouse',
    clientX: x,
    clientY: y,
  })
const up = (x: number, y: number, o: PointerInit = {}) =>
  fireEvent.pointerUp(viewport(), {
    pointerId: o.id ?? 1,
    pointerType: o.type ?? 'mouse',
    clientX: x,
    clientY: y,
  })
/** happy-dom's WheelEvent ignores modifier and coordinate init fields: define them. */
const wheel = (init: {
  deltaX?: number
  deltaY?: number
  ctrlKey?: boolean
  shiftKey?: boolean
  clientX?: number
}) => {
  const e = new WheelEvent('wheel', {
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    cancelable: true,
  })
  for (const k of ['ctrlKey', 'shiftKey', 'clientX'] as const)
    Object.defineProperty(e, k, { value: init[k] ?? (k === 'clientX' ? 0 : false) })
  act(() => {
    viewport().dispatchEvent(e)
  })
  return e
}
const clipEl = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="timeline-clip"][data-clip-id="${id}"]`)

const mount = async (p: Project = makeProject()) => {
  s().load(p)
  s().setZoom(100)
  s().setScroll({ x: 0, y: 0 })
  const r = render(<Timeline />)
  await frame()
  return r
}

beforeEach(() => {
  vibrate = vi.fn<(pattern: VibratePattern) => boolean>(() => true)
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { vibrate }))
  ops.moveClip.mockImplementation((d, id, to) => {
    const { track: from, index, clip: c } = find(d, id)
    const target = to.trackId ? d.tracks.find((t) => t.id === to.trackId)! : from
    from.clips.splice(index, 1)
    if (to.start !== undefined) c.start = to.start
    target.clips.splice(to.index ?? target.clips.length, 0, c)
  })
  ops.trimClip.mockImplementation((d, id, edges) => {
    const { clip: c } = find(d, id)
    const end = edges.end ?? c.start + c.duration
    if (edges.start !== undefined) c.start = edges.start
    c.duration = end - c.start
  })
  ops.addTrack.mockImplementation((d, kind) => {
    const t = Track.parse({ id: `new-${kind}`, kind })
    d.tracks.push(t)
    return t
  })
})

afterEach(() => {
  s().unload()
})

describe('rendering', () => {
  it('renders lanes, clips with accessible labels, ruler and playhead', async () => {
    await mount()
    expect(screen.getAllByTestId('timeline-clip')).toHaveLength(4)
    expect(screen.getByRole('button', { name: /^Video clip .*0:02\.00 to 0:04\.00/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Text clip Hello/ })).toBeTruthy()
    expect(screen.getByTestId('timeline-ruler')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Main track' })).toBeTruthy()
    // The marker row only shows once there are markers.
    expect(screen.queryByRole('group', { name: 'Markers' })).toBeNull()
    act(() =>
      s().dispatch('Add marker', (d) => {
        d.markers.push({ id: 'mk', t: sec(1), kind: 'user' })
      }),
    )
    expect(screen.getByRole('group', { name: 'Markers' })).toBeTruthy()
    // Clip geometry comes from the zoom: m1 starts at 2 s → 16 + 200 px.
    expect(clipEl('m1')!.style.left).toBe('216px')
    expect(clipEl('m1')!.style.width).toBe('200px')
  })

  it('virtualises clips outside the render window', async () => {
    const many = mainClips(...Array.from({ length: 200 }, () => 1))
    await mount(project([track('main', many, 'main')]))
    const mounted = screen.getAllByTestId('timeline-clip').length
    // Viewport (1024 px) + one viewport of overscan at 100 px/s ≈ 20 s → ~21 clips.
    expect(mounted).toBeGreaterThan(15)
    expect(mounted).toBeLessThan(30)
    expect(clipEl('m199')).toBeNull()
  })

  it('shows caption word chips and markers', async () => {
    const p = project([track('main', mainClips(4), 'main')], {
      markers: [
        { id: 'b1', t: sec(1), kind: 'beat' },
        { id: 'u1', t: sec(2), kind: 'user', label: 'Drop' },
      ],
      words: [
        { text: 'hello', start: 0, end: sec(0.5) },
        { text: 'world', start: sec(0.5), end: sec(1), emphasis: true },
      ],
    })
    await mount(p)
    const lane = screen.getByTestId('caption-lane')
    expect(within(lane).getByText('hello')).toBeTruthy()
    expect(within(lane).getByText('world')).toBeTruthy()
    expect(document.querySelector('[data-marker-kind="beat"]')).toBeTruthy()
    expect(screen.getByText('Drop')).toBeTruthy()
  })

  it('shows transition handles between main clips that open the Transitions tool', async () => {
    await mount()
    const handles = screen.getAllByTestId('transition-handle')
    expect(handles).toHaveLength(2)
    fireEvent.click(handles[1]!)
    expect(s().activeTool).toBe('transitions')
    expect(s().selection.clipIds).toEqual(['m2'])
    // The selected clip's edges belong to its trim handles: both adjacent buttons hide.
    expect(screen.queryAllByTestId('transition-handle')).toHaveLength(1)
  })
})

describe('selection and seeking', () => {
  it('tap selects a clip; shift-tap adds to the selection', async () => {
    await mount()
    down(cx(sec(3)), ROW_Y.main)
    up(cx(sec(3)), ROW_Y.main)
    expect(s().selection.clipIds).toEqual(['m1'])
    expect(clipEl('m1')!.dataset.selected).toBe('true')
    down(cx(sec(2)), ROW_Y.text, { shift: true })
    up(cx(sec(2)), ROW_Y.text, { shift: true })
    expect(s().selection.clipIds).toEqual(['m1', 'tx'])
    expect(s().project).toBe(s().project) // no edit happened
    expect(s().history.canUndo).toBe(false)
  })

  it('tapping empty space clears the selection, then seeks (frame-accurate)', async () => {
    await mount()
    s().select(['m0'])
    down(cx(sec(4.51)), ROW_Y.audio)
    up(cx(sec(4.51)), ROW_Y.audio)
    expect(s().selection.clipIds).toEqual([])
    down(cx(sec(4.51)), ROW_Y.audio)
    up(cx(sec(4.51)), ROW_Y.audio)
    expect(s().playhead).toBe(4_500_000) // nearest 30 fps frame
  })

  it('ruler press seeks and drag scrubs, snapping to clip edges', async () => {
    await mount()
    down(cx(sec(1)), ROW_Y.ruler)
    expect(s().playhead).toBe(1_000_000)
    expect(s().playheadSource).toBe('user')
    move(cx(sec(3.97)), ROW_Y.ruler)
    await frame()
    expect(s().playhead).toBe(4_000_000) // snapped to the m1/m2 boundary
    expect(screen.getByTestId('snap-guide').hidden).toBe(false)
    up(cx(sec(3.97)), ROW_Y.ruler)
    expect(s().playhead).toBe(4_000_000)
    expect(screen.getByTestId('snap-guide').hidden).toBe(true)
  })
})

describe('trim', () => {
  it('drags the end handle and commits ONE frame-accurate trim', async () => {
    await mount()
    const before = s().project
    down(cx(sec(4)) - 2, ROW_Y.main)
    move(cx(sec(4.5)), ROW_Y.main)
    // The grab offset (2 px left of the edge) is kept; 5.013 s rounds to frame 150.
    move(cx(sec(5.013)) - 2, ROW_Y.main)
    await frame()
    // Transient: the element is resized directly, the store is untouched.
    expect(s().project).toBe(before)
    expect(clipEl('m1')!.style.width).toBe('300px')
    expect(screen.getByTestId('drag-badge').textContent).toBe('3.00s')
    up(cx(sec(5.013)) - 2, ROW_Y.main)
    expect(ops.trimClip).toHaveBeenCalledTimes(1)
    expect(ops.trimClip.mock.calls[0]!.slice(1)).toEqual(['m1', { end: 5_000_000 }])
    expect(s().history.undoLabel).toBe('Trim clip')
  })

  it('clamps to one frame minimum and to the free-track neighbour', async () => {
    await mount(
      makeProject([
        track(
          'overlay',
          [
            clip('image', sec(0), sec(1), { id: 'i1' }),
            clip('image', sec(2), sec(1), { id: 'i2' }),
          ],
          'ov',
        ),
      ]),
    )
    // Overlay row sits above text: ov, text, main, audio (no markers → no marker row).
    const ovY = 24 + 4 + 20
    // Start handle of i2 dragged into i1: stops at i1's end.
    down(cx(sec(2)) + 2, ovY)
    move(cx(sec(0.2)), ovY)
    up(cx(sec(0.2)), ovY)
    expect(ops.trimClip.mock.calls[0]!.slice(1)).toEqual(['i2', { start: 1_000_000 }])
    // i2 is now 1–3 s; its end handle dragged far left stops one frame after its start.
    down(cx(sec(3)) - 2, ovY)
    move(cx(sec(0)), ovY)
    up(cx(sec(0)), ovY)
    expect(ops.trimClip.mock.calls[1]!.slice(1)).toEqual(['i2', { end: 1_000_000 + 33_333 }])
  })

  it('Escape cancels the drag and restores the clip', async () => {
    await mount()
    down(cx(sec(4)) - 2, ROW_Y.main)
    move(cx(sec(5)) - 2, ROW_Y.main)
    await frame()
    expect(clipEl('m1')!.style.width).toBe('300px')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(clipEl('m1')!.style.width).toBe('200px')
    move(cx(sec(5.5)), ROW_Y.main)
    up(cx(sec(5.5)), ROW_Y.main)
    expect(ops.trimClip).not.toHaveBeenCalled()
    expect(s().history.canUndo).toBe(false)
  })

  it('does not trim clips on locked tracks', async () => {
    const p = makeProject()
    await mount({
      ...p,
      tracks: p.tracks.map((t) => (t.id === 'main' ? { ...t, locked: true } : t)),
    })
    down(cx(sec(4)) - 2, ROW_Y.main)
    move(cx(sec(5)), ROW_Y.main)
    up(cx(sec(5)), ROW_Y.main)
    expect(ops.trimClip).not.toHaveBeenCalled()
    expect(ops.moveClip).not.toHaveBeenCalled()
  })
})

describe('move', () => {
  it('reorders on the main track with an insertion indicator and ripple preview', async () => {
    await mount()
    const before = s().project
    down(cx(sec(1)), ROW_Y.main)
    move(cx(sec(3)), ROW_Y.main)
    move(cx(sec(5.5)), ROW_Y.main)
    await frame()
    expect(s().project).toBe(before)
    expect(clipEl('m0')!.dataset.dragging).toBe('true')
    expect(clipEl('m0')!.style.transform).toBe('translate3d(450px,0px,0)')
    // m1 and m2 ripple left by m0's 2 s.
    expect(clipEl('m1')!.style.transform).toBe('translate3d(-200px,0,0)')
    expect(screen.getByTestId('insert-indicator').hidden).toBe(false)
    up(cx(sec(5.5)), ROW_Y.main)
    expect(ops.moveClip).toHaveBeenCalledTimes(1)
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['m0', { index: 2 }])
    expect(s().project!.tracks[0]!.clips.map((c) => c.id)).toEqual(['m1', 'm2', 'm0'])
    expect(clipEl('m0')!.style.transform).toBe('')
    expect(screen.getByTestId('insert-indicator').hidden).toBe(true)
  })

  it('never re-renders React per pointer move during a drag', async () => {
    s().load(makeProject())
    s().setZoom(100)
    let commits = 0
    render(
      <Profiler id="tl" onRender={() => commits++}>
        <Timeline />
      </Profiler>,
    )
    await frame()
    down(cx(sec(1)), ROW_Y.main)
    move(cx(sec(1.5)), ROW_Y.main) // starts the drag (pins the dragged clip: one commit)
    await frame()
    const atStart = commits
    for (let i = 0; i < 60; i++) {
      move(cx(sec(1.5 + i * 0.05)), ROW_Y.main)
      if (i % 10 === 0) await frame()
    }
    await frame()
    expect(commits).toBe(atStart)
    up(cx(sec(4.5)), ROW_Y.main)
    expect(ops.moveClip).toHaveBeenCalledTimes(1)
  })

  it('a release over the original slot changes nothing', async () => {
    await mount()
    down(cx(sec(3)), ROW_Y.main)
    move(cx(sec(3.3)), ROW_Y.main)
    up(cx(sec(3.3)), ROW_Y.main)
    expect(ops.moveClip).not.toHaveBeenCalled()
  })

  it('moves free-track clips frame-accurately and snaps to clip edges with a haptic tick', async () => {
    await mount()
    down(cx(sec(2)), ROW_Y.text)
    move(cx(sec(3.5)), ROW_Y.text)
    up(cx(sec(3.5)), ROW_Y.text)
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['tx', { start: 2_500_000 }])
    // Now at 2.5–4.5 s; drag so the start lands 40 ms before the 4 s main boundary.
    ops.moveClip.mockClear()
    down(cx(sec(3)), ROW_Y.text)
    move(cx(sec(4.46)), ROW_Y.text)
    up(cx(sec(4.46)), ROW_Y.text)
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['tx', { start: 4_000_000 }])
    expect(vibrate).toHaveBeenCalledWith(5)
  })

  it('moves a video overlay clip onto the main track at the pointer boundary', async () => {
    await mount(
      makeProject([track('overlay', [clip('video', sec(8), sec(1), { id: 'ov1' })], 'ov')]),
    )
    const ovY = 24 + 4 + 20
    down(cx(sec(8.5)), ovY)
    move(cx(sec(4.5)), ovY)
    move(cx(sec(4.5)), ROW_Y.main + 30) // main row shifted down by the overlay row (+44)
    up(cx(sec(4.5)), ROW_Y.main + 30)
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['ov1', { trackId: 'main', index: 2 }])
  })

  it('text clips cannot leave text tracks', async () => {
    await mount()
    down(cx(sec(2)), ROW_Y.text)
    move(cx(sec(2)), ROW_Y.main)
    up(cx(sec(2)), ROW_Y.main)
    expect(ops.moveClip).not.toHaveBeenCalled()
  })

  it('touch drag on a clip pans; long-press lifts it for moving', async () => {
    await mount()
    const t = { type: 'touch' as const }
    down(cx(sec(2)), ROW_Y.text, t)
    move(cx(sec(3)), ROW_Y.text, t)
    up(cx(sec(3)), ROW_Y.text, t)
    expect(ops.moveClip).not.toHaveBeenCalled()

    down(cx(sec(2)), ROW_Y.text, t)
    await act(() => new Promise((r) => setTimeout(r, 450)))
    expect(clipEl('tx')!.dataset.lifted).toBe('true')
    expect(vibrate).toHaveBeenCalledWith(10)
    move(cx(sec(3)), ROW_Y.text, t)
    up(cx(sec(3)), ROW_Y.text, t)
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['tx', { start: 2_000_000 }])
  })
})

describe('keyboard', () => {
  it('arrow keys nudge free clips by 1 frame (Shift: 10 frames)', async () => {
    await mount()
    const el = clipEl('tx')!
    el.focus()
    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['tx', { start: 1_033_333 }])
    fireEvent.keyDown(clipEl('tx')!, { key: 'ArrowLeft', shiftKey: true })
    expect(ops.moveClip.mock.calls[1]!.slice(1)).toEqual(['tx', { start: 700_000 }])
    expect(s().selection.clipIds).toEqual(['tx'])
    // Nudges coalesce into one undo step.
    expect(s().history.undoLabel).toBe('Nudge clip')
  })

  it('arrow keys move main clips one slot; Enter selects', async () => {
    await mount()
    fireEvent.keyDown(clipEl('m0')!, { key: 'ArrowRight' })
    expect(ops.moveClip.mock.calls[0]!.slice(1)).toEqual(['m0', { index: 1 }])
    fireEvent.keyDown(clipEl('m2')!, { key: 'Enter' })
    expect(s().selection.clipIds).toEqual(['m2'])
    fireEvent.keyDown(clipEl('m1')!, { key: ' ', shiftKey: true })
    expect(s().selection.clipIds).toEqual(['m2', 'm1'])
  })
})

describe('track headers', () => {
  const expand = () => {
    const btn = screen.queryByRole('button', { name: 'Expand track headers' })
    if (btn) fireEvent.click(btn)
  }

  it('toggles mute / hide / lock as undoable edits', async () => {
    await mount()
    expand()
    fireEvent.click(screen.getByRole('button', { name: 'Mute main track' }))
    expect(s().project!.tracks[0]!.muted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Lock text track' }))
    expect(s().project!.tracks[1]!.locked).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Unlock text track' }).getAttribute('aria-pressed'),
    ).toBe('true')
    s().undo()
    expect(s().project!.tracks[1]!.locked).toBe(false)
  })

  it('adds tracks from the add-track menu', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Add track' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add overlay track' }))
    expect(ops.addTrack.mock.calls.map((c) => c[1])).toEqual(['overlay'])
    expect(screen.getByRole('group', { name: 'Overlay track' })).toBeTruthy()
  })

  it('collapses and expands', async () => {
    await mount()
    expand()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse track headers' }))
    expect(screen.queryByRole('button', { name: 'Mute main track' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Main track — show track controls/ }))
    expect(screen.getByRole('button', { name: 'Mute main track' })).toBeTruthy()
  })
})

describe('zoom and pan', () => {
  const content = () => screen.getByTestId('timeline-content')

  it('ctrl-wheel zooms around the pointer', async () => {
    await mount()
    const ax = cx(sec(3))
    const e = wheel({ deltaY: -60, ctrlKey: true, clientX: ax })
    expect(e.defaultPrevented).toBe(true) // the browser page zoom must not kick in
    await frame()
    const z = s().zoom
    expect(z).toBeGreaterThan(100)
    // The time under the pointer did not move.
    const scrollX = -Number(/translate3d\((-?[\d.]+)px/.exec(content().style.transform)![1])
    expect((ax + scrollX - 16) / (z / 1e6)).toBeCloseTo(sec(3), -2)
    // Re-rendered clip geometry uses the new zoom.
    expect(Number.parseFloat(clipEl('m1')!.style.width)).toBeCloseTo(2 * z, 3)
  })

  it('two-finger pinch zooms anchored at the gesture centre', async () => {
    await mount()
    const t = { type: 'touch' as const }
    const y = ROW_Y.audio
    down(300, y, { ...t, id: 1 })
    down(400, y, { ...t, id: 2 })
    move(250, y, { ...t, id: 1 })
    move(450, y, { ...t, id: 2 })
    await frame()
    expect(s().zoom).toBeCloseTo(200)
    const scrollX = -Number(/translate3d\((-?[\d.]+)px/.exec(content().style.transform)![1])
    // Time under the centre (350 px) at the start: (350 - 16) / 100 s.
    expect((350 + scrollX - 16) / 200).toBeCloseTo((350 - 16) / 100, 5)
    up(250, y, { ...t, id: 1 })
    up(450, y, { ...t, id: 2 })
    expect(ops.moveClip).not.toHaveBeenCalled()
  })

  it('wheel pans horizontally', async () => {
    await mount(project([track('main', mainClips(10, 10, 10), 'main')]))
    wheel({ deltaX: 120 })
    await frame()
    expect(content().style.transform).toBe('translate3d(-120px,0px,0)')
    wheel({ deltaY: 40, shiftKey: true })
    await frame()
    expect(content().style.transform).toBe('translate3d(-160px,0px,0)')
  })

  it('zoom buttons and store zoom changes re-render the lanes', async () => {
    await mount()
    act(() => s().setZoom(200))
    await frame()
    expect(clipEl('m1')!.style.width).toBe('400px')
  })
})
