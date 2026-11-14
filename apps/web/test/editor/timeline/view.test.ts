/**
 * TimelineView: scroll clamping, zoom anchoring, frame-coalesced zoom, playback auto-follow,
 * kinetic scrolling, drag-session auto-scroll and overlays, on detached DOM elements.
 * happy-dom has zero-size boxes, so the view measures `window.innerWidth` (1024) × 240.
 */
import { sec } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_PAD, FOLLOW_AT } from '@/editor/timeline/constants.ts'
import {
  TimelineView,
  type Session,
  type ViewCallbacks,
  type ViewElements,
} from '@/editor/timeline/view.ts'
import { createEditorStore, type EditorStoreApi } from '@/state/index.ts'
import { mainClips, project, track } from './helpers.ts'

let store: EditorStoreApi
let view: TimelineView
let els: ViewElements
const onWindow = vi.fn<ViewCallbacks['onWindow']>()
const onPin = vi.fn<ViewCallbacks['onPin']>()
const W = 1024

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
/** Real-time frames (~60 Hz): the animations are time-based, not frame-counted. */
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 16))
    await frame()
  }
}
const translateX = (el: HTMLElement) =>
  Number(/translate3d\((-?[\d.]+)px/.exec(el.style.transform)?.[1] ?? Number.NaN)

beforeEach(() => {
  store = createEditorStore()
  store.getState().load(project([track('main', mainClips(30, 30), 'main')])) // 60 s
  store.getState().setZoom(100)
  const div = () => document.body.appendChild(document.createElement('div'))
  els = {
    viewport: div(),
    content: div(),
    ruler: document.body.appendChild(document.createElement('canvas')),
    headers: div(),
    playhead: div(),
    guide: div(),
    indicator: div(),
    badge: div(),
  }
  view = new TimelineView(store, { onWindow, onPin })
  view.attach(els, { rowsHeight: 600, endUs: sec(60), fps: 30 })
})

afterEach(() => {
  view.destroy()
  document.body.innerHTML = ''
})

describe('layout and scroll', () => {
  it('measures, publishes the render window and paints the scroll offset', () => {
    expect(view.width).toBe(W)
    expect(onWindow).toHaveBeenCalled()
    const w = onWindow.mock.calls.at(-1)![0] as { start: number; end: number }
    expect(w.start).toBe(0)
    expect(w.end).toBeGreaterThan(sec(10))
    view.scrollTo(500, 50)
    view.flush()
    expect(els.content.style.transform).toBe('translate3d(-500px,-50px,0)')
    expect(els.headers!.style.transform).toBe('translate3d(0,-50px,0)')
  })

  it('clamps scroll to the content (+ tail space) and the rows height', () => {
    view.scrollTo(1e9, 1e9)
    // 60 s at 100 px/s + pad + half a viewport of tail space − one viewport.
    expect(view.scrollX).toBe(CONTENT_PAD + 6000 + W / 2 - W)
    expect(view.scrollY).toBe(600 - (240 - 24))
    view.scrollTo(-100, -100)
    expect(view.scrollX).toBe(0)
    expect(view.scrollY).toBe(0)
  })

  it('re-clamps when content shrinks and persists scroll to the store when settled', async () => {
    view.scrollTo(5000)
    view.setLayout({ rowsHeight: 100, endUs: sec(10), fps: 30 })
    expect(view.scrollX).toBe(Math.max(0, CONTENT_PAD + 1000 + W / 2 - W))
    expect(view.scrollY).toBe(0)
    view.destroy()
    expect(store.getState().scroll.x).toBe(view.scrollX)
  })

  it('only re-publishes the window when the viewport leaves the covered range', () => {
    onWindow.mockClear()
    view.scrollTo(100)
    expect(onWindow).not.toHaveBeenCalled()
    view.scrollTo(2000)
    expect(onWindow).toHaveBeenCalledTimes(1)
  })
})

describe('zoom', () => {
  it('zoomTo keeps the time under the anchor and writes the store', () => {
    view.scrollTo(1000)
    const t = view.timeAtViewportX(300)
    view.zoomTo(250, 300)
    expect(store.getState().zoom).toBe(250)
    expect(view.timeAtViewportX(300)).toBeCloseTo(t, 0)
  })

  it('queueZoom coalesces many events into one zoom per frame', async () => {
    const setZoom = vi.spyOn(store.getState(), 'setZoom')
    for (let i = 1; i <= 10; i++) view.queueZoom(100 + i * 10, 200)
    expect(view.pendingZoom).toBe(200)
    expect(store.getState().zoom).toBe(100)
    await frame()
    expect(store.getState().zoom).toBe(200)
    expect(setZoom).toHaveBeenCalledTimes(1)
  })

  it('pinch anchor time stays under the (moving) centre', async () => {
    const anchorT = view.timeAtViewportX(400)
    view.queueZoom(300, 450, anchorT)
    await frame()
    expect(view.timeAtViewportX(450)).toBeCloseTo(anchorT, 0)
  })

  it('external zoom changes anchor at the playhead when it is visible', () => {
    store.getState().setPlayhead(sec(5)) // x = 516 px
    const before = view.viewportXOf(sec(5))
    store.getState().setZoom(400)
    expect(view.zoom).toBe(400)
    expect(view.viewportXOf(sec(5))).toBeCloseTo(before, 3)
  })

  it('fitZoom fits the project into the viewport', () => {
    const z = view.fitZoom()
    expect(z * 60).toBeLessThan(W)
    expect(z * 60).toBeGreaterThan(W / 2)
  })
})

describe('playhead and auto-follow', () => {
  it('places the playhead and hides it off-screen', () => {
    store.getState().setPlayhead(sec(2))
    view.flush()
    expect(translateX(els.playhead)).toBe(CONTENT_PAD + 200)
    store.getState().setPlayhead(sec(50), 'engine')
    view.flush()
    expect(els.playhead.hidden).toBe(true)
  })

  it('chases the playhead at FOLLOW_AT of the width during playback', () => {
    const s = store.getState()
    s.setPlaying(true)
    const t = sec(9) // x = 916 > 0.8 × 1024
    s.setPlayhead(t, 'engine')
    expect(view.viewportXOf(t)).toBeCloseTo(W * FOLLOW_AT, 3)
  })

  it('pauses auto-follow after a user scroll', () => {
    const s = store.getState()
    s.setPlaying(true)
    view.scrollBy(10, 0, true)
    s.setPlayhead(sec(9), 'engine')
    expect(view.scrollX).toBe(10)
  })

  it('reveals user seeks outside the viewport with a smooth scroll', async () => {
    store.getState().setPlayhead(sec(40))
    expect(view.animating).toBe(true)
    await frames(25)
    expect(view.animating).toBe(false)
    expect(view.viewportXOf(sec(40))).toBeCloseTo(W / 2, 0)
  })

  it('does not follow while a gesture is interacting', () => {
    view.interacting = true
    store.getState().setPlayhead(sec(40))
    expect(view.animating).toBe(false)
  })
})

describe('kinetic scrolling', () => {
  it('flings with decaying velocity and promotes the layer only while moving', async () => {
    view.fling(2, 0)
    expect(view.animating).toBe(true)
    await frame()
    expect(els.content.style.willChange).toBe('transform')
    await frames(5)
    const mid = view.scrollX
    expect(mid).toBeGreaterThan(0)
    // v decays to the stop speed after τ·ln(v / v_min) ≈ 1.5 s.
    for (let i = 0; i < 200 && view.animating; i++) await frames(1)
    expect(view.animating).toBe(false)
    expect(view.scrollX).toBeGreaterThan(mid)
    // Total ≈ v × τ = 650 px.
    expect(view.scrollX).toBeGreaterThan(550)
    expect(view.scrollX).toBeLessThan(700)
    await frame()
    expect(els.content.style.willChange).toBe('')
  })

  it('ignores tiny flings and stops at the content edge', async () => {
    view.fling(0.01, 0)
    expect(view.animating).toBe(false)
    view.fling(-3, 0)
    await frame()
    expect(view.animating).toBe(false)
    expect(view.scrollX).toBe(0)
  })
})

describe('drag sessions and overlays', () => {
  it('auto-scrolls while the session asks for it and lets it refresh', async () => {
    const render = vi.fn<Session['render']>()
    const refresh = vi.fn<Session['refresh']>()
    const session: Session = { render, autoScroll: () => 20, refresh }
    view.beginSession(session, ['m0'])
    expect(onPin).toHaveBeenCalledWith(new Set(['m0']))
    expect(view.interacting).toBe(true)
    await frames(3)
    expect(view.scrollX).toBeGreaterThan(30)
    expect(refresh).toHaveBeenCalled()
    expect(render).toHaveBeenCalled()
    view.endSession()
    expect(onPin).toHaveBeenLastCalledWith(new Set())
    expect(view.interacting).toBe(false)
  })

  it('positions and hides the guide, indicator and badge', () => {
    view.setGuide(sec(1), 'beat')
    expect(els.guide.hidden).toBe(false)
    expect(els.guide.dataset.kind).toBe('beat')
    expect(translateX(els.guide)).toBe(CONTENT_PAD + 100)
    view.setIndicator(sec(2), 40, 56)
    expect(els.indicator.style.height).toBe('64px')
    view.setBadge('1.00s', 5000, 10)
    expect(els.badge.textContent).toBe('1.00s')
    expect(translateX(els.badge)).toBe(W - 64)
    view.endSession()
    expect(els.guide.hidden && els.indicator.hidden && els.badge.hidden).toBe(true)
  })

  it('tracks registered clip elements', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    view.registerClip('c', a)
    view.registerClip('c', b)
    view.unregisterClip('c', a) // stale element: keeps the newer one
    expect(view.clipEls.get('c')).toBe(b)
    view.unregisterClip('c', b)
    expect(view.clipEls.has('c')).toBe(false)
  })
})
