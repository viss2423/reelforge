/**
 * TimelineView: the imperative half of the timeline. It owns scroll position, zoom
 * anchoring, the canvas ruler, the playhead, overlays (snap guide, insertion indicator,
 * info badge), kinetic/smooth scroll animations and playback auto-follow, and writes all of
 * them to the DOM in one requestAnimationFrame pass. React never re-renders for any of this:
 * it only re-renders the lanes when the render window (virtualisation range) or zoom
 * changes.
 */
import { ZOOM_MAX, ZOOM_MIN, type EditorStore, type EditorStoreApi } from '@/state/index.ts'
import { FOLLOW_AT, FOLLOW_PAUSE_MS, RULER_HEIGHT, TAIL_SPACE } from './constants.ts'
import {
  computeWindow,
  firstTickIndex,
  maxScrollX,
  pxPerUs,
  tickLabel,
  tickSpec,
  tickTime,
  timeToX,
  windowCovers,
  xToTime,
  zoomAnchoredScroll,
  type TimeWindow,
} from './geometry.ts'
import { anchoredScroll } from './dragMath.ts'
import { FLING_MIN_SPEED, flingStep } from './inertia.ts'
import { perfEnd, perfStart } from './perf.ts'
import type { SnapKind } from './snapping.ts'

export interface ViewElements {
  /** Input surface and size reference: ruler + lanes. */
  viewport: HTMLElement
  /** Lanes content, translated by the scroll offset. */
  content: HTMLElement
  ruler: HTMLCanvasElement
  /** Track header column content (vertical scroll only). */
  headers: HTMLElement | null
  playhead: HTMLElement
  guide: HTMLElement
  indicator: HTMLElement
  badge: HTMLElement
  /** Marquee (box selection) rectangle, viewport coordinates. */
  marquee?: HTMLElement | null
  /** Slip ghost filmstrip (whole source around the slipped clip). */
  ghost?: HTMLElement | null
}

/** A pointer drag in progress (move / trim / scrub); see sessions.ts. */
export interface Session {
  /** Writes transient visuals; called inside the view's animation frame. */
  render(): void
  /** Edge auto-scroll speed for the current pointer (px per 60 Hz frame). */
  autoScroll(): number
  /** Recomputes the drag after the view scrolled under a stationary pointer. */
  refresh(): void
}

/** React-side callbacks: both trigger a lane re-render, never per frame. */
export interface ViewCallbacks {
  /** The render window moved (virtualisation). */
  onWindow: (w: TimeWindow) => void
  /** Clips that must stay mounted outside the window (being dragged). */
  onPin: (ids: ReadonlySet<string>) => void
}

export interface ViewLayout {
  rowsHeight: number
  endUs: number
  fps: number
}

type Anim =
  | { kind: 'fling'; vx: number; vy: number }
  | { kind: 'smooth'; fromX: number; toX: number; t0: number; dur: number }

const EMPTY_SET: ReadonlySet<string> = new Set()

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export class TimelineView {
  scrollX = 0
  scrollY = 0
  width = 0
  height = 0
  zoom: number
  ppu: number
  fps = 30
  endUs = 0
  rowsHeight = 0
  window: TimeWindow = { start: 0, end: 0 }
  /** Extra timeline length allowed while a drag extends past the end. */
  extraEndUs = 0
  /** True while a gesture owns the playhead or scroll (no auto-follow / reveal). */
  interacting = false

  /** DOM targets; assigned by `attach` (the view is created before React commits them). */
  els!: ViewElements
  readonly store: EditorStoreApi
  /**
   * Mounted clip elements by id, filled by ref callbacks from the first commit on (before
   * `attach`), so drag sessions can animate them without React.
   */
  readonly clipEls = new Map<string, HTMLElement>()

  session: Session | null = null
  #attached = false
  #onWindow: (w: TimeWindow) => void
  #onPin: (ids: ReadonlySet<string>) => void
  #raf = 0
  #lastFrame = 0
  #anim: Anim | null = null
  #dirtyScroll = true
  #dirtyRuler = true
  #dirtyPlayhead = true
  #dirtySession = false
  #followPausedUntil = 0
  #pendingZoom: { zoom: number; anchorX: number; anchorT: number | undefined } | null = null
  #panning = false
  #colors = { tick: '#6c6c7c', label: '#a3a3b2', major: '#a3a3b2' }
  #rulerSize = { w: 0, h: 0, dpr: 0 }
  #cleanups: Array<() => void> = []
  #scrollSaveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(store: EditorStoreApi, callbacks: ViewCallbacks) {
    this.store = store
    this.#onWindow = callbacks.onWindow
    this.#onPin = callbacks.onPin
    const s = store.getState()
    this.zoom = s.zoom
    this.ppu = pxPerUs(s.zoom)
    this.scrollX = s.scroll.x
    this.scrollY = s.scroll.y
  }

  /** Binds the DOM and starts observing size, theme and the store until `destroy`. */
  attach(els: ViewElements, layout: ViewLayout): void {
    this.els = els
    this.#attached = true
    // Re-sync with the store: a previous attach (StrictMode remount) may have left state.
    const s = this.store.getState()
    this.zoom = s.zoom
    this.ppu = pxPerUs(s.zoom)
    this.#dirtyScroll = this.#dirtyRuler = this.#dirtyPlayhead = true
    this.setLayout(layout)
    this.#measure()
    this.#readColors()
    const vp = this.els.viewport
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.#measure())
      ro.observe(vp)
      this.#cleanups.push(() => ro.disconnect())
    }
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => {
        this.#readColors()
        this.#dirtyRuler = true
        this.requestFrame()
      })
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      this.#cleanups.push(() => mo.disconnect())
    }
    this.#cleanups.push(this.store.subscribe((next, prev) => this.#onStore(next, prev)))
    this.#updateWindow(true)
    this.requestFrame()
  }

  destroy(): void {
    for (const c of this.#cleanups) c()
    this.#cleanups = []
    if (this.#raf) cancelAnimationFrame(this.#raf)
    this.#raf = 0
    this.#anim = null
    this.#pendingZoom = null
    this.session = null
    if (this.#attached) this.#saveScroll(true)
    this.#attached = false
  }

  setLayout(l: ViewLayout): void {
    const fpsChanged = l.fps !== this.fps
    this.rowsHeight = l.rowsHeight
    this.endUs = l.endUs
    this.fps = l.fps
    if (!this.#attached) return
    if (fpsChanged) this.#dirtyRuler = true
    // Content may have shrunk (delete/undo): keep the scroll in range.
    this.scrollTo(this.scrollX, this.scrollY)
    this.requestFrame()
  }

  /* ------------------------------------------------------------------ coordinates */

  /** Converts client coordinates to viewport and content coordinates. */
  point(clientX: number, clientY: number, rect: DOMRect | { left: number; top: number }) {
    const vx = clientX - rect.left
    const vy = clientY - rect.top
    return {
      vx,
      vy,
      /** Content x (time axis). */
      x: vx + this.scrollX,
      /** Lanes y (below the ruler, scroll applied). */
      y: vy - RULER_HEIGHT + this.scrollY,
      inRuler: vy < RULER_HEIGHT,
      t: xToTime(vx + this.scrollX, this.ppu),
    }
  }

  timeAtViewportX(vx: number): number {
    return xToTime(vx + this.scrollX, this.ppu)
  }

  viewportXOf(t: number): number {
    return timeToX(t, this.ppu) - this.scrollX
  }

  /* ------------------------------------------------------------------ scroll */

  maxX(): number {
    const end = Math.max(this.endUs, this.extraEndUs, this.store.getState().playhead)
    return maxScrollX(end, this.ppu, this.width, TAIL_SPACE)
  }

  maxY(): number {
    return Math.max(0, this.rowsHeight - (this.height - RULER_HEIGHT))
  }

  /** Scrolls to (x, y), clamped. `user` scrolls pause playback auto-follow. */
  scrollTo(x: number, y = this.scrollY, user = false): void {
    const nx = clamp(x, 0, this.maxX())
    const ny = clamp(y, 0, this.maxY())
    if (user) this.#followPausedUntil = performance.now() + FOLLOW_PAUSE_MS
    if (nx === this.scrollX && ny === this.scrollY) return
    this.scrollX = nx
    this.scrollY = ny
    this.#dirtyScroll = true
    this.#updateWindow()
    this.requestFrame()
    this.#saveScroll()
  }

  scrollBy(dx: number, dy: number, user = false): void {
    this.scrollTo(this.scrollX + dx, this.scrollY + dy, user)
  }

  /** Kinetic fling with velocity in px/ms (positive = content moves left/up). */
  fling(vx: number, vy: number): void {
    if (Math.hypot(vx, vy) < FLING_MIN_SPEED * 4) return
    this.#anim = { kind: 'fling', vx, vy }
    this.#syncScrolling()
    this.requestFrame()
  }

  smoothScrollTo(x: number, dur = 240): void {
    const toX = clamp(x, 0, this.maxX())
    if (Math.abs(toX - this.scrollX) < 1) return
    this.#anim = { kind: 'smooth', fromX: this.scrollX, toX, t0: performance.now(), dur }
    this.requestFrame()
  }

  stopAnimation(): void {
    this.#anim = null
  }

  /**
   * Marks a pan/pinch in progress. The content layer is promoted (`will-change`) only
   * while panning or animating, not permanently (a huge layer costs GPU memory on phones).
   */
  setPanning(on: boolean): void {
    this.#panning = on
    this.#syncScrolling()
  }

  #syncScrolling(): void {
    const value = this.#panning || this.#anim ? 'transform' : ''
    const style = this.els.content.style
    if (style.willChange !== value) style.willChange = value
  }

  get animating(): boolean {
    return this.#anim !== null
  }

  /* ------------------------------------------------------------------ zoom */

  /** Sets the zoom (px/s) keeping the time under viewport x `anchorX` fixed. */
  zoomTo(zoom: number, anchorX = this.width / 2): void {
    const z = clamp(zoom, ZOOM_MIN, ZOOM_MAX)
    if (z === this.zoom) return
    this.#applyZoom(z, zoomAnchoredScroll(this.scrollX, anchorX, this.ppu, pxPerUs(z)))
  }

  /** Zoom that will be applied on the next frame (accumulates wheel steps). */
  get pendingZoom(): number {
    return this.#pendingZoom?.zoom ?? this.zoom
  }

  /**
   * Queues a zoom for the next animation frame, so pointer/wheel events faster than the
   * display (120 Hz touch, trackpads) cost one lane re-render per frame. Without `anchorT`
   * the time under viewport x `anchorX` stays put; with it (pinch), time `anchorT` is placed
   * under `anchorX`, so the content also follows the fingers when they pan.
   */
  queueZoom(zoom: number, anchorX: number, anchorT?: number): void {
    this.#pendingZoom = { zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX), anchorX, anchorT }
    this.requestFrame()
  }

  #flushZoom(): void {
    const p = this.#pendingZoom
    if (!p) return
    this.#pendingZoom = null
    if (p.zoom === this.zoom && p.anchorT === undefined) return
    const t = p.anchorT ?? this.timeAtViewportX(p.anchorX)
    this.#applyZoom(p.zoom, anchoredScroll(t, pxPerUs(p.zoom), p.anchorX))
  }

  /** Zoom that fits the whole project in the viewport. */
  fitZoom(): number {
    const usable = Math.max(1, this.width * (1 - TAIL_SPACE / 2) - 32)
    const seconds = Math.max(1, this.endUs / 1_000_000)
    return clamp(usable / seconds, ZOOM_MIN, ZOOM_MAX)
  }

  #applyZoom(z: number, scrollX: number): void {
    this.zoom = z
    this.ppu = pxPerUs(z)
    this.#dirtyRuler = true
    this.#dirtyPlayhead = true
    this.#dirtySession = this.session !== null
    // Order matters: the store update re-renders the lanes (in a microtask, before paint)
    // and the scroll below lands in the same frame, so the anchor never visibly drifts.
    // `this.zoom` is already z, so the store listener treats this change as our own.
    this.store.getState().setZoom(z)
    this.scrollTo(scrollX, this.scrollY)
    this.#dirtyScroll = true
    this.#updateWindow(true)
    this.requestFrame()
  }

  /* ------------------------------------------------------------------ overlays */

  /** Shows the snap guide at time t (null hides it). */
  setGuide(t: number | null, kind: SnapKind | null = null): void {
    const g = this.els.guide
    if (t === null) {
      g.hidden = true
      return
    }
    g.hidden = false
    g.dataset.kind = kind ?? 'clip'
    g.style.transform = `translate3d(${this.viewportXOf(t)}px,0,0)`
  }

  /** Shows the insertion indicator at time t on the row at lanes y (null hides it). */
  setIndicator(t: number | null, rowY = 0, rowHeight = 0): void {
    const el = this.els.indicator
    if (t === null) {
      el.hidden = true
      return
    }
    el.hidden = false
    el.style.height = `${rowHeight + 8}px`
    el.style.transform = `translate3d(${this.viewportXOf(t) - 1}px,${RULER_HEIGHT + rowY - this.scrollY - 4}px,0)`
  }

  /** Floating info badge (e.g. trimmed duration) at viewport coordinates. */
  setBadge(text: string | null, vx = 0, vy = 0): void {
    const el = this.els.badge
    if (text === null) {
      el.hidden = true
      return
    }
    el.hidden = false
    if (el.textContent !== text) el.textContent = text
    const x = clamp(vx, 4, Math.max(4, this.width - 64))
    el.style.transform = `translate3d(${x}px,${Math.max(0, vy)}px,0)`
  }

  /* ------------------------------------------------------------------ clip registry */

  /** Ref-callback helper for clip elements (sessions animate them by id). */
  registerClip(id: string, el: HTMLElement): void {
    this.clipEls.set(id, el)
    // A drag re-applies its transforms to remounted elements on the next frame.
    if (this.session) this.invalidateSession()
  }

  /** Removes `el` unless the id was already re-registered by a newer element. */
  unregisterClip(id: string, el: HTMLElement): void {
    if (this.clipEls.get(id) === el) this.clipEls.delete(id)
  }

  /* ------------------------------------------------------------------ session */

  /** Starts a drag; `pinned` clips stay mounted even if auto-scroll moves them off-window. */
  beginSession(s: Session, pinned: readonly string[] = []): void {
    this.session = s
    this.interacting = true
    this.stopAnimation()
    if (pinned.length) this.#onPin(new Set(pinned))
    this.invalidateSession()
  }

  endSession(): void {
    const had = this.session !== null
    this.session = null
    this.interacting = false
    this.extraEndUs = 0
    this.setGuide(null)
    this.setIndicator(null)
    this.setBadge(null)
    if (had) this.#onPin(EMPTY_SET)
  }

  invalidateSession(): void {
    this.#dirtySession = true
    this.requestFrame()
  }

  /* ------------------------------------------------------------------ frame loop */

  requestFrame(): void {
    if (this.#attached && !this.#raf) this.#raf = requestAnimationFrame(this.#frame)
  }

  #frame = (now: number): void => {
    this.#raf = 0
    const t0 = perfStart()
    const dt = this.#lastFrame ? Math.min(64, now - this.#lastFrame) : 1000 / 60
    this.#flushZoom()
    let again = this.#stepAnimation(now, dt)
    const s = this.session
    if (s) {
      const speed = s.autoScroll()
      if (speed !== 0) {
        const before = this.scrollX
        this.scrollBy(speed * (dt / (1000 / 60)), 0)
        if (this.scrollX !== before) s.refresh()
        again = true
      }
    }
    this.#write()
    this.#syncScrolling()
    this.#lastFrame = again ? now : 0
    if (again) this.requestFrame()
    perfEnd('tl:frame', t0)
  }

  /** Applies pending zoom and DOM writes synchronously (tests). */
  flush(): void {
    this.#flushZoom()
    this.#write()
  }

  #write(): void {
    const { content, headers } = this.els
    if (this.#dirtyScroll) {
      content.style.transform = `translate3d(${-this.scrollX}px,${-this.scrollY}px,0)`
      if (headers) headers.style.transform = `translate3d(0,${-this.scrollY}px,0)`
      this.#dirtyRuler = true
      this.#dirtyPlayhead = true
      if (this.session) this.#dirtySession = true
      this.#dirtyScroll = false
    }
    if (this.#dirtyRuler) {
      this.#drawRuler()
      this.#dirtyRuler = false
    }
    if (this.#dirtyPlayhead) {
      this.#placePlayhead()
      this.#dirtyPlayhead = false
    }
    if (this.#dirtySession && this.session) {
      this.#dirtySession = false
      this.session.render()
    }
  }

  #stepAnimation(now: number, dt: number): boolean {
    const a = this.#anim
    if (!a) return false
    if (a.kind === 'fling') {
      const x = flingStep(a.vx, dt)
      const y = flingStep(a.vy, dt)
      a.vx = x.v
      a.vy = y.v
      const bx = this.scrollX
      const by = this.scrollY
      this.scrollBy(x.dx, y.dx)
      const stuck = this.scrollX === bx && this.scrollY === by
      if (stuck || Math.hypot(a.vx, a.vy) < FLING_MIN_SPEED) this.#anim = null
    } else {
      const p = Math.min(1, (now - a.t0) / a.dur)
      this.scrollTo(a.fromX + (a.toX - a.fromX) * easeOutCubic(p))
      if (p >= 1) this.#anim = null
    }
    return this.#anim !== null
  }

  /* ------------------------------------------------------------------ store */

  #onStore(s: EditorStore, prev: EditorStore): void {
    if (s.zoom !== prev.zoom && s.zoom !== this.zoom) {
      // Zoom from elsewhere (keyboard +/−, toolbar): anchor at the playhead if visible.
      const px = this.viewportXOf(s.playhead)
      const anchor = px >= 0 && px <= this.width ? px : this.width / 2
      const ppu = pxPerUs(s.zoom)
      const x = zoomAnchoredScroll(this.scrollX, anchor, this.ppu, ppu)
      this.zoom = s.zoom
      this.ppu = ppu
      this.#dirtyRuler = true
      this.scrollTo(x)
      this.#dirtyScroll = true
      this.#updateWindow(true)
      this.requestFrame()
    }
    if (s.playhead !== prev.playhead || s.playing !== prev.playing) {
      this.#dirtyPlayhead = true
      this.requestFrame()
      this.#follow(s, prev)
    }
  }

  /**
   * Playback auto-follow: the playhead chases at FOLLOW_AT of the width (continuous, so it
   * is as smooth as playback) and jumps back into view with a short ease when it leaves
   * it. User seeks out of view (Home/End, frame steps) are revealed the same way.
   */
  #follow(s: EditorStore, prev: EditorStore): void {
    if (this.interacting || this.width === 0) return
    const x = this.viewportXOf(s.playhead)
    if (s.playing) {
      if (performance.now() < this.#followPausedUntil) return
      if (x > this.width * FOLLOW_AT && x <= this.width + 24 && !this.#anim) {
        this.scrollTo(timeToX(s.playhead, this.ppu) - this.width * FOLLOW_AT)
      } else if (x < 0 || x > this.width + 24) {
        this.smoothScrollTo(timeToX(s.playhead, this.ppu) - this.width * 0.2)
      }
    } else if (s.playheadSource === 'user' && s.playhead !== prev.playhead) {
      if (x < 0 || x > this.width)
        this.smoothScrollTo(timeToX(s.playhead, this.ppu) - this.width / 2)
    }
  }

  /* ------------------------------------------------------------------ drawing */

  #measure(): void {
    const vp = this.els.viewport
    const r = vp.getBoundingClientRect()
    // happy-dom / hidden containers report 0: fall back so geometry stays usable.
    const w = vp.clientWidth || r.width || (typeof window !== 'undefined' ? window.innerWidth : 0)
    const h = vp.clientHeight || r.height || 240
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.#dirtyRuler = true
    this.#dirtyPlayhead = true
    this.scrollTo(this.scrollX, this.scrollY)
    this.#updateWindow(true)
    this.requestFrame()
  }

  #readColors(): void {
    if (typeof getComputedStyle === 'undefined') return
    const cs = getComputedStyle(this.els.viewport)
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
    this.#colors = {
      tick: v('--rf-subtle', '#6c6c7c'),
      label: v('--rf-muted', '#a3a3b2'),
      major: v('--rf-muted', '#a3a3b2'),
    }
  }

  #drawRuler(): void {
    const canvas = this.els.ruler
    const ctx = canvas.getContext('2d')
    if (!ctx || this.width === 0) return
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    const rs = this.#rulerSize
    if (rs.w !== this.width || rs.h !== RULER_HEIGHT || rs.dpr !== dpr) {
      canvas.width = Math.round(this.width * dpr)
      canvas.height = RULER_HEIGHT * dpr
      canvas.style.width = `${this.width}px`
      canvas.style.height = `${RULER_HEIGHT}px`
      this.#rulerSize = { w: this.width, h: RULER_HEIGHT, dpr }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, RULER_HEIGHT)
    const spec = tickSpec(this.ppu, this.fps)
    const t0 = Math.max(0, this.timeAtViewportX(0))
    const t1 = this.timeAtViewportX(this.width + 40)
    ctx.font = '10px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace'
    ctx.textBaseline = 'top'
    for (let i = firstTickIndex(spec, t0, this.fps); ; i++) {
      const t = tickTime(spec, i, this.fps)
      if (t > t1) break
      const x = Math.round(this.viewportXOf(t))
      const major = i % spec.majorEvery === 0
      ctx.fillStyle = major ? this.#colors.major : this.#colors.tick
      ctx.fillRect(x, major ? RULER_HEIGHT - 9 : RULER_HEIGHT - 5, 1, major ? 9 : 5)
      if (major) {
        ctx.fillStyle = this.#colors.label
        ctx.fillText(tickLabel(t, spec, this.fps), x + 3, 4)
      }
    }
  }

  #placePlayhead(): void {
    const x = this.viewportXOf(this.store.getState().playhead)
    const el = this.els.playhead
    const visible = x >= -12 && x <= this.width + 12
    el.hidden = !visible
    if (visible) el.style.transform = `translate3d(${x}px,0,0)`
  }

  /* ------------------------------------------------------------------ window & persistence */

  #updateWindow(force = false): void {
    if (this.width === 0) return
    if (!force && windowCovers(this.window, this.scrollX, this.width, this.ppu)) return
    const w = computeWindow(this.scrollX, this.width, this.ppu)
    if (w.start === this.window.start && w.end === this.window.end) return
    this.window = w
    this.#onWindow(w)
  }

  /** Persists the scroll to the store when scrolling settles (not per frame). */
  #saveScroll(now = false): void {
    clearTimeout(this.#scrollSaveTimer)
    const save = () => this.store.getState().setScroll({ x: this.scrollX, y: this.scrollY })
    if (now) save()
    else this.#scrollSaveTimer = setTimeout(save, 250)
  }
}
