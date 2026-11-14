/**
 * Unified input for the timeline (Pointer Events for touch, mouse and pen; wheel; Safari
 * trackpad gestures; Escape). A small state machine decides what a press becomes:
 *
 * - ruler / markers lane            → scrub (seek on press)
 * - clip trim handle                → trim
 * - clip body, mouse/pen            → move after a few px; tap selects (Shift/Ctrl/⌘ toggles)
 * - clip body, touch                → pan; long-press lifts the clip (haptic) → drag moves it,
 *                                     release without moving toggles multi-selection
 * - empty lane                      → pan (touch flings); tap deselects, or seeks if nothing
 *                                     is selected
 * - second finger                   → pinch-zoom anchored between the fingers (+ pan)
 * - ctrl/⌘-wheel, trackpad pinch    → zoom at the pointer; wheel / shift-wheel pans
 *
 * Pointer moves never touch React: they update session state and the view paints in rAF.
 */
import { snapToFrame } from '@reelforge/core'
import { haptic } from '@/lib/haptics.ts'
import type { EditorStoreApi } from '@/state/index.ts'
import {
  DRAG_THRESHOLD_MOUSE,
  DRAG_THRESHOLD_TOUCH,
  HAPTIC_LIFT,
  LONG_PRESS_MS,
} from './constants.ts'
import { pinchZoom, wheelPixels, wheelZoomFactor } from './dragMath.ts'
import { contentEnd, type Row } from './geometry.ts'
import { hitTest, type Hit } from './hitTest.ts'
import { VelocityTracker } from './inertia.ts'
import { ZOOM_MAX, ZOOM_MIN } from '@/state/index.ts'
import {
  MoveSession,
  ScrubSession,
  TrimSession,
  type PointerPos,
  type SessionContext,
} from './sessions.ts'
import type { TimelineView } from './view.ts'

type ClipHit = Extract<Hit, { kind: 'clip' }>
type DragSession = ScrubSession | MoveSession | TrimSession

type State =
  | { kind: 'idle' }
  | {
      kind: 'press'
      id: number
      hit: Hit
      x: number
      y: number
      touch: boolean
      additive: boolean
      lifted: boolean
      timer: ReturnType<typeof setTimeout> | undefined
    }
  | { kind: 'pan'; id: number; x: number; y: number; touch: boolean }
  | { kind: 'pinch'; a: number; b: number; dist: number; zoom: number; anchorT: number }
  | { kind: 'drag'; id: number; session: DragSession }
  /** Drag cancelled with Escape: ignore the pointer until it lifts. */
  | { kind: 'cancelled'; id: number }

/** Safari's non-standard trackpad pinch event. */
interface GestureEvent extends UIEvent {
  scale: number
  clientX: number
  clientY: number
}

export interface GestureDeps {
  view: TimelineView
  store: EditorStoreApi
  rows: () => readonly Row[]
}

const isIgnored = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-tl-ignore]') !== null

export class TimelineGestures {
  readonly #deps: GestureDeps
  readonly #pointers = new Map<number, PointerPos & { touch: boolean }>()
  readonly #velocity = new VelocityTracker()
  #state: State = { kind: 'idle' }
  #rect: { left: number; top: number } = { left: 0, top: 0 }
  #gestureZoom = 0
  #cleanups: Array<() => void> = []

  constructor(deps: GestureDeps) {
    this.#deps = deps
  }

  /** Current state kind (tests / debugging). */
  get state(): State['kind'] {
    return this.#state.kind
  }

  attach(): void {
    const vp = this.#deps.view.els.viewport
    const on = (
      target: EventTarget,
      type: string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts)
      this.#cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts))
    }
    on(vp, 'pointerdown', this.#onDown)
    on(vp, 'pointermove', this.#onMove)
    on(vp, 'pointerup', this.#onUp)
    on(vp, 'pointercancel', this.#onCancel)
    on(vp, 'lostpointercapture', this.#onLost)
    on(vp, 'wheel', this.#onWheel, { passive: false })
    on(vp, 'contextmenu', this.#onContextMenu)
    on(vp, 'gesturestart', this.#onGestureStart)
    on(vp, 'gesturechange', this.#onGestureChange)
    on(window, 'keydown', this.#onKey, { capture: true })
  }

  destroy(): void {
    this.#abort()
    for (const c of this.#cleanups) c()
    this.#cleanups = []
  }

  /* ------------------------------------------------------------------ helpers */

  #ctx(touch: boolean): SessionContext {
    return {
      view: this.#deps.view,
      store: this.#deps.store,
      rows: this.#deps.rows(),
      touch,
      rect: this.#rect,
    }
  }

  #hit(clientX: number, clientY: number, touch: boolean) {
    const { view, store } = this.#deps
    const s = store.getState()
    const pt = view.point(clientX, clientY, this.#rect)
    if (pt.inRuler) return { pt, hit: null }
    const hit = hitTest(
      {
        rows: this.#deps.rows(),
        ppu: view.ppu,
        selected: new Set(s.selection.clipIds),
        touch,
        markers: s.project?.markers ?? [],
        words: s.project?.captions?.words ?? [],
      },
      pt.x,
      pt.y,
    )
    return { pt, hit }
  }

  #startDrag(id: number, session: DragSession, pinned: readonly string[] = []): void {
    this.#deps.view.beginSession(session, pinned)
    this.#state = { kind: 'drag', id, session }
  }

  #select(hit: ClipHit, additive: boolean): void {
    const s = this.#deps.store.getState()
    if (additive) s.toggleSelect(hit.clip.id)
    else s.select([hit.clip.id], { trackId: hit.track.id })
    this.#deps.view.clipEls.get(hit.clip.id)?.focus({ preventScroll: true })
  }

  /** Selects the clip a drag starts on unless it is already part of the selection. */
  #ensureSelected(hit: ClipHit): void {
    const s = this.#deps.store.getState()
    if (!s.selection.clipIds.includes(hit.clip.id))
      s.select([hit.clip.id], { trackId: hit.track.id })
  }

  #clearPress(): void {
    const st = this.#state
    if (st.kind !== 'press') return
    clearTimeout(st.timer)
    if (st.hit.kind === 'clip') delete this.#deps.view.clipEls.get(st.hit.clip.id)?.dataset.lifted
  }

  #startPan(id: number, x: number, y: number, touch: boolean): void {
    this.#clearPress()
    this.#velocity.reset()
    this.#velocity.add(performance.now(), x, y)
    this.#deps.view.setPanning(true)
    this.#state = { kind: 'pan', id, x, y, touch }
  }

  #startPinch(): void {
    this.#clearPress()
    const [a, b] = [...this.#pointers.entries()]
    if (!a || !b) return
    const { view } = this.#deps
    const cx = (a[1].clientX + b[1].clientX) / 2 - this.#rect.left
    this.#deps.view.setPanning(true)
    this.#state = {
      kind: 'pinch',
      a: a[0],
      b: b[0],
      dist: Math.hypot(a[1].clientX - b[1].clientX, a[1].clientY - b[1].clientY),
      zoom: view.zoom,
      anchorT: view.timeAtViewportX(cx),
    }
  }

  /** Ends whatever is in progress without committing (unmount, lost capture). */
  #abort(): void {
    const st = this.#state
    this.#clearPress()
    if (st.kind === 'drag') {
      st.session.cancel()
      this.#deps.view.endSession()
    }
    this.#deps.view.setPanning(false)
    this.#pointers.clear()
    this.#state = { kind: 'idle' }
  }

  /* ------------------------------------------------------------------ pointer */

  #onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (isIgnored(e.target)) return
    const { view } = this.#deps
    const touch = e.pointerType === 'touch'
    this.#pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, touch })
    try {
      view.els.viewport.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic events (tests) have no active pointer to capture.
    }
    view.stopAnimation()
    if (this.#pointers.size === 2) {
      if (this.#state.kind === 'press' || this.#state.kind === 'pan') this.#startPinch()
      return
    }
    if (this.#pointers.size > 2 || this.#state.kind !== 'idle') return
    e.preventDefault()
    const r = view.els.viewport.getBoundingClientRect()
    this.#rect = { left: r.left, top: r.top }
    const { pt, hit } = this.#hit(e.clientX, e.clientY, touch)
    const p = { clientX: e.clientX, clientY: e.clientY }
    const s = this.#deps.store.getState()
    if (!s.project) return

    // Ruler and markers lane scrub; with a mouse the playhead line itself is grabbable.
    const nearPlayhead = !touch && Math.abs(pt.vx - view.viewportXOf(s.playhead)) <= 5
    const trim = hit?.kind === 'clip' && hit.zone !== 'body' && !hit.track.locked
    if (!hit || hit.kind === 'markers' || (nearPlayhead && !trim)) {
      this.#startDrag(e.pointerId, new ScrubSession(this.#ctx(touch), p))
      return
    }
    if (trim && hit.kind === 'clip') {
      this.#ensureSelected(hit)
      this.#startDrag(
        e.pointerId,
        new TrimSession(
          this.#ctx(touch),
          hit,
          p,
          'assetId' in hit.clip && hit.clip.assetId ? s.assets[hit.clip.assetId] : undefined,
        ),
        [hit.clip.id],
      )
      return
    }
    const press: Extract<State, { kind: 'press' }> = {
      kind: 'press',
      id: e.pointerId,
      hit,
      x: e.clientX,
      y: e.clientY,
      touch,
      additive: e.shiftKey || e.ctrlKey || e.metaKey,
      lifted: false,
      timer: undefined,
    }
    if (touch && hit.kind === 'clip' && !hit.track.locked) {
      press.timer = setTimeout(() => {
        if (this.#state !== press) return
        press.lifted = true
        haptic(HAPTIC_LIFT)
        const el = view.clipEls.get(hit.clip.id)
        if (el) el.dataset.lifted = 'true'
      }, LONG_PRESS_MS)
    }
    this.#state = press
  }

  #onMove = (e: PointerEvent): void => {
    const ptr = this.#pointers.get(e.pointerId)
    if (!ptr) return
    ptr.clientX = e.clientX
    ptr.clientY = e.clientY
    const st = this.#state
    const { view } = this.#deps
    switch (st.kind) {
      case 'press': {
        if (st.id !== e.pointerId) return
        const threshold = st.touch ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE
        if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < threshold) return
        const hit = st.hit
        if (hit.kind === 'clip' && !hit.track.locked && (!st.touch || st.lifted)) {
          this.#clearPress()
          this.#ensureSelected(hit)
          const session = new MoveSession(this.#ctx(st.touch), hit, {
            clientX: e.clientX,
            clientY: e.clientY,
          })
          this.#startDrag(st.id, session, session.ids)
          return
        }
        this.#startPan(st.id, st.x, st.y, st.touch)
        this.#onMove(e)
        return
      }
      case 'pan': {
        if (st.id !== e.pointerId) return
        view.scrollBy(st.x - e.clientX, st.y - e.clientY, true)
        st.x = e.clientX
        st.y = e.clientY
        this.#velocity.add(e.timeStamp || performance.now(), e.clientX, e.clientY)
        return
      }
      case 'pinch': {
        const a = this.#pointers.get(st.a)
        const b = this.#pointers.get(st.b)
        if (!a || !b) return
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const cx = (a.clientX + b.clientX) / 2 - this.#rect.left
        const zoom = pinchZoom(st.zoom, st.dist, dist, ZOOM_MIN, ZOOM_MAX)
        view.queueZoom(zoom, cx, st.anchorT)
        return
      }
      case 'drag':
        if (st.id === e.pointerId) st.session.move({ clientX: e.clientX, clientY: e.clientY })
        return
      default:
    }
  }

  #onUp = (e: PointerEvent): void => {
    if (!this.#pointers.has(e.pointerId)) return
    this.#pointers.delete(e.pointerId)
    const st = this.#state
    const { view } = this.#deps
    switch (st.kind) {
      case 'press': {
        if (st.id !== e.pointerId) return
        this.#clearPress()
        this.#state = { kind: 'idle' }
        this.#tap(st)
        return
      }
      case 'pan': {
        if (st.id !== e.pointerId) return
        this.#state = { kind: 'idle' }
        const v = this.#velocity.velocity(e.timeStamp || performance.now())
        if (st.touch) view.fling(-v.vx, -v.vy)
        view.setPanning(false)
        return
      }
      case 'pinch': {
        // Continue as a pan with the remaining finger (no jump).
        const rest = [...this.#pointers.entries()][0]
        if (rest) this.#startPan(rest[0], rest[1].clientX, rest[1].clientY, rest[1].touch)
        else {
          this.#state = { kind: 'idle' }
          view.setPanning(false)
        }
        return
      }
      case 'drag': {
        if (st.id !== e.pointerId) return
        this.#state = { kind: 'idle' }
        st.session.move({ clientX: e.clientX, clientY: e.clientY })
        view.endSession()
        st.session.commit()
        return
      }
      case 'cancelled':
        if (st.id === e.pointerId) this.#state = { kind: 'idle' }
        return
      default:
    }
  }

  #tap(st: Extract<State, { kind: 'press' }>): void {
    const { store } = this.#deps
    const s = store.getState()
    const hit = st.hit
    if (hit.kind === 'clip') {
      this.#select(hit, st.additive || st.lifted)
      return
    }
    if (hit.kind === 'captions' && hit.word >= 0) {
      const w = s.project?.captions?.words[hit.word]
      if (w) {
        s.setPlaying(false)
        s.setPlayhead(w.start)
      }
      return
    }
    if (s.selection.clipIds.length) {
      s.clearSelection()
      return
    }
    if (!s.project) return
    s.setPlaying(false)
    const t = Math.min(contentEnd(s.project), Math.max(0, hit.t))
    s.setPlayhead(snapToFrame(t, s.project.settings.fps))
  }

  #onCancel = (e: PointerEvent): void => {
    if (!this.#pointers.has(e.pointerId)) return
    const st = this.#state
    if ('id' in st && st.id === e.pointerId) this.#abort()
    else this.#pointers.delete(e.pointerId)
  }

  #onLost = (e: PointerEvent): void => {
    // Capture lost without pointerup (element removed, OS gesture): treat as cancel.
    if (this.#pointers.has(e.pointerId)) this.#onCancel(e)
  }

  #onContextMenu = (e: Event): void => {
    // Long-press must lift the clip, not open the browser menu.
    e.preventDefault()
  }

  #onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    const st = this.#state
    if (st.kind === 'drag') {
      e.preventDefault()
      e.stopPropagation()
      st.session.cancel()
      this.#deps.view.endSession()
      this.#state = { kind: 'cancelled', id: st.id }
    } else if (st.kind === 'press') {
      e.preventDefault()
      e.stopPropagation()
      this.#clearPress()
      this.#state = { kind: 'cancelled', id: st.id }
    }
  }

  /* ------------------------------------------------------------------ wheel & gestures */

  #onWheel = (e: WheelEvent): void => {
    const { view } = this.#deps
    e.preventDefault()
    const r = view.els.viewport.getBoundingClientRect()
    const dx = wheelPixels(e.deltaX, e.deltaMode, view.width)
    const dy = wheelPixels(e.deltaY, e.deltaMode, view.height)
    if (e.ctrlKey || e.metaKey) {
      // Ctrl-wheel and trackpad pinch (Chrome/Edge/Firefox report pinch as ctrl+wheel).
      view.queueZoom(view.pendingZoom * wheelZoomFactor(dy), e.clientX - r.left)
      return
    }
    view.stopAnimation()
    if (e.shiftKey) view.scrollBy(dy || dx, 0, true)
    else if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) view.scrollBy(dx, 0, true)
    else if (view.maxY() > 0) view.scrollBy(dx, dy, true)
    else view.scrollBy(dy, 0, true)
  }

  #onGestureStart = (e: GestureEvent): void => {
    e.preventDefault()
    this.#gestureZoom = this.#deps.view.zoom
  }

  #onGestureChange = (e: GestureEvent): void => {
    e.preventDefault()
    const { view } = this.#deps
    const r = view.els.viewport.getBoundingClientRect()
    view.queueZoom(this.#gestureZoom * e.scale, e.clientX - r.left)
  }
}
