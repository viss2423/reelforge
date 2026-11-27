/**
 * OverlayController: the imperative half of on-canvas editing (same pattern as the
 * timeline's TimelineView + gestures). It positions the selection frame, guides, crop UI
 * and badge with inline styles in requestAnimationFrame, and turns pointer input into
 * transform gestures:
 *
 * - tap a visual clip → select it (top-most under the finger); tap empty canvas → deselect
 * - drag a clip → move (snaps to centre, edges and safe zones; haptic tick on snap)
 * - corner handle → scale about the centre; rotate handle → rotate (0/90/180/270 snap,
 *   Shift = 15° steps); two fingers → move + pinch-scale + twist together
 * - double-tap a text clip → inline text editing (handled by the React shell)
 * - crop mode → drag the crop window's edges/corners over the whole source frame
 *
 * While a gesture runs, the result is previewed by handing the engine a patched project
 * (`setPreviewOverride`) — the store and React are untouched — and the release commits ONE
 * dispatch (one undo step). Properties that have keyframes get a keyframe written or
 * updated at the playhead; constant properties change their value.
 */
import { snapToFrame, type Crop, type Project, type Us } from '@reelforge/core'
import { produce, type Draft } from 'immer'
import { toast } from '@/components/Toast.tsx'
import { haptic } from '@/lib/haptics.ts'
import type { EditorStore, EditorStoreApi } from '@/state/editorStore.ts'
import { setAnimatable, valueAt } from '../../panels/model/keyframes.ts'
import { perfEnd, perfStart } from '../../timeline/perf.ts'
import { setPreviewOverride } from '../previewOverride.ts'
import {
  MAX_SCALE,
  MIN_SCALE,
  angleOf,
  cornerScale,
  cropRect,
  dragCrop,
  fullFrame,
  pinchDelta,
  poseOf,
  snapAngle,
  snapMove,
  snapScale,
  topmostAt,
  visibleAt,
  type CropHandle,
  type CropSide,
  type Guide,
  type Placed,
  type Pose,
} from './geometry.ts'

/** Space (CSS px) the rotate handle needs above a frame. */
const ROT_HANDLE_ROOM = 40

export interface OverlayElements {
  /** Input surface covering the preview box. */
  root: HTMLElement
  frame: HTMLElement
  guideX: HTMLElement
  guideY: HTMLElement
  badge: HTMLElement
  cropFull: HTMLElement
  cropRect: HTMLElement
}

export interface OverlayCallbacks {
  /** Double-tap on a text clip. */
  onEditText(clipId: string): void
}

export type TransformValues = { x: number; y: number; scale: number; rotation: number }
type Prop = keyof TransformValues

/** CSS px a press may travel before it becomes a drag. */
const DRAG_PX = { mouse: 3, touch: 8 }
/** Snap distance in CSS px. */
const SNAP_PX = 8
/** Extra hit slop around clips for touch (CSS px). */
const TOUCH_SLOP_PX = 12
const DOUBLE_TAP_MS = 350
const HAPTIC_SNAP = 6

/** Tolerances below which a property counts as unchanged (no keyframe written). */
const EPS: Record<Prop, number> = { x: 0.005, y: 0.005, scale: 1e-5, rotation: 0.005 }
const ROUND: Record<Prop, number> = { x: 100, y: 100, scale: 10000, rotation: 100 }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Writes transform values (keyframe-aware) onto clip `clipId` of a draft. */
export function applyTransform(
  d: Draft<Project>,
  clipId: string,
  values: Partial<TransformValues>,
  keyT: Us,
): void {
  const fps = d.settings.fps
  for (const track of d.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (!clip || clip.type === 'audio') continue
    for (const [prop, v] of Object.entries(values) as Array<[Prop, number]>) {
      setAnimatable(clip.transform[prop], keyT, Math.round(v * ROUND[prop]) / ROUND[prop], fps)
    }
    return
  }
}

const r4 = (v: number) => Math.round(v * 10000) / 10000

/** Writes a crop onto media clip `clipId` of a draft. */
export function applyCrop(d: Draft<Project>, clipId: string, crop: Crop): void {
  for (const track of d.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip && (clip.type === 'video' || clip.type === 'image')) {
      const r = r4
      clip.crop = {
        left: r(crop.left),
        top: r(crop.top),
        right: r(crop.right),
        bottom: r(crop.bottom),
      }
      return
    }
  }
}

interface PointerInfo {
  x: number
  y: number
  touch: boolean
}

type Gesture =
  | {
      kind: 'move' | 'scale' | 'rotate' | 'pinch'
      placed: Placed
      base: Project
      pose: Pose
      v0: TransformValues
      keyT: Us
      /** Canvas px of the pointer(s) at the start. */
      p0: Array<[number, number]>
      ids: number[]
      values: TransformValues
      guides: Guide[]
      snapped: string
    }
  | {
      kind: 'crop'
      placed: Placed
      full: Pose
      crop0: Crop
      crop: Crop
      handle: CropHandle
      id: number
    }

type Press = {
  id: number
  x: number
  y: number
  touch: boolean
  hit: { placed: Placed; pose: Pose } | null
  moved: boolean
}

export class OverlayController {
  readonly store: EditorStoreApi
  els!: OverlayElements
  /** CSS px per canvas px. */
  k = 0
  cropMode = false
  readonly #cb: OverlayCallbacks
  readonly #pointers = new Map<number, PointerInfo>()
  #press: Press | null = null
  #gesture: Gesture | null = null
  #raf = 0
  #rect = { left: 0, top: 0 }
  #lastTap: { clipId: string; at: number } | null = null
  #shift = false
  #alt = false
  #cleanups: Array<() => void> = []
  /** Natural sizes of pack stickers (loaded lazily). */
  readonly #stickerSizes = new Map<string, { width: number; height: number }>()

  constructor(store: EditorStoreApi, cb: OverlayCallbacks) {
    this.store = store
    this.#cb = cb
  }

  attach(els: OverlayElements): void {
    this.els = els
    const on = (
      t: EventTarget,
      type: string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ) => {
      t.addEventListener(type, fn as EventListener, opts)
      this.#cleanups.push(() => t.removeEventListener(type, fn as EventListener, opts))
    }
    on(els.root, 'pointerdown', this.#onDown)
    on(els.root, 'pointermove', this.#onMove)
    on(els.root, 'pointerup', this.#onUp)
    on(els.root, 'pointercancel', this.#onCancel)
    on(els.root, 'lostpointercapture', this.#onLost)
    on(window, 'keydown', this.#onKey, { capture: true })
    on(window, 'keyup', this.#onKeyUp, { capture: true })
    this.#cleanups.push(this.store.subscribe((s, prev) => this.#onStore(s, prev)))
    this.requestFrame()
  }

  destroy(): void {
    this.#cancelGesture()
    for (const c of this.#cleanups) c()
    this.#cleanups = []
    if (this.#raf) cancelAnimationFrame(this.#raf)
    this.#raf = 0
  }

  setSize(cssWidth: number): void {
    const k = cssWidth / 1080
    if (k === this.k) return
    this.k = k
    this.requestFrame()
  }

  setCropMode(on: boolean): void {
    if (this.#gesture?.kind === 'crop' && !on) this.#cancelGesture()
    this.cropMode = on
    this.requestFrame()
  }

  get gesture(): Gesture['kind'] | null {
    return this.#gesture?.kind ?? null
  }

  /* ------------------------------------------------------------------ queries */

  #stickerSize = (ref: string) => {
    const hit = this.#stickerSizes.get(ref)
    if (hit) return hit
    return undefined
  }

  /** Visible clips at the playhead with their poses, bottom → top. */
  placedNow(project = this.store.getState().project): Array<{ placed: Placed; pose: Pose }> {
    const s = this.store.getState()
    if (!project) return []
    return visibleAt(project, s.playhead).map((placed) => ({
      placed,
      pose: poseOf(placed, s.assets, this.#stickerSize),
    }))
  }

  /** The selected clip if it is visible now (single selection only). */
  selectedNow(project = this.store.getState().project) {
    const ids = this.store.getState().selection.clipIds
    if (ids.length !== 1) return undefined
    return this.placedNow(project).find((x) => x.placed.clip.id === ids[0])
  }

  /** Canvas px of a client point. */
  #canvasPoint(clientX: number, clientY: number): [number, number] {
    const k = this.k || 1
    return [(clientX - this.#rect.left) / k, (clientY - this.#rect.top) / k]
  }

  /* ------------------------------------------------------------------ pointer */

  #onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('[data-ov-ignore]')) return
    const touch = e.pointerType === 'touch'
    if (this.#pointers.size === 0) {
      const r = this.els.root.getBoundingClientRect()
      this.#rect = { left: r.left, top: r.top }
    }
    this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, touch })
    try {
      this.els.root.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic events (tests) have no active pointer to capture.
    }
    e.preventDefault()
    this.#shift = e.shiftKey
    this.#alt = e.altKey

    // Second finger: pinch / twist the clip the first finger is on (or the selection).
    if (this.#pointers.size === 2) {
      const sel = this.#press?.hit ?? this.selectedNow()
      const g = this.#gesture
      const placed = g && g.kind !== 'crop' ? { placed: g.placed, pose: g.pose } : sel
      if (g?.kind === 'crop') return
      if (g) this.#cancelGesture()
      this.#press = null
      if (placed) this.#startTransform('pinch', placed)
      return
    }
    if (this.#pointers.size > 2 || this.#gesture) return

    const [x, y] = this.#canvasPoint(e.clientX, e.clientY)
    const handle = target?.closest<HTMLElement>('[data-handle]')?.dataset.handle
    const cropHandle = target?.closest<HTMLElement>('[data-crop]')?.dataset.crop
    const sel = this.selectedNow()
    if (this.cropMode && cropHandle && sel) {
      this.#startCrop(sel, cropHandle.split(',') as CropSide[], e.pointerId)
      return
    }
    if (handle && sel && !this.cropMode) {
      this.#startTransform(handle === 'rot' ? 'rotate' : 'scale', sel, [[x, y]], [e.pointerId])
      return
    }
    const items = this.placedNow()
    const slop = touch ? TOUCH_SLOP_PX / (this.k || 1) : 0
    const hit = topmostAt(items, x, y, slop)
    if (hit) {
      const s = this.store.getState()
      if (!(s.selection.clipIds.length === 1 && s.selection.clipIds[0] === hit.placed.clip.id))
        s.select([hit.placed.clip.id], { trackId: hit.placed.track.id })
    }
    this.#press = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      touch,
      hit: hit ?? null,
      moved: false,
    }
  }

  #onMove = (e: PointerEvent): void => {
    const ptr = this.#pointers.get(e.pointerId)
    if (!ptr) return
    ptr.x = e.clientX
    ptr.y = e.clientY
    this.#shift = e.shiftKey
    this.#alt = e.altKey
    const press = this.#press
    if (press && press.id === e.pointerId && !this.#gesture) {
      const th = press.touch ? DRAG_PX.touch : DRAG_PX.mouse
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < th) return
      press.moved = true
      if (press.hit && !this.cropMode) {
        this.#press = null
        this.#startTransform('move', press.hit, [this.#canvasPoint(press.x, press.y)], [press.id])
      }
    }
    if (this.#gesture) this.requestFrame()
  }

  #onUp = (e: PointerEvent): void => {
    const ptr = this.#pointers.get(e.pointerId)
    if (!ptr) return
    ptr.x = e.clientX
    ptr.y = e.clientY
    const g = this.#gesture
    // The gesture result is computed with the lifting pointer still in place.
    const involved = g && (g.kind === 'crop' ? g.id === e.pointerId : g.ids.includes(e.pointerId))
    if (involved) this.#commitGesture()
    this.#pointers.delete(e.pointerId)
    if (g) {
      if (involved) {
        // A remaining finger may not start anything new until it lifts.
        this.#press = null
      }
      return
    }
    const press = this.#press
    this.#press = null
    if (!press || press.id !== e.pointerId || press.moved) return
    this.#tap(press)
  }

  #tap(press: Press): void {
    const s = this.store.getState()
    if (!press.hit) {
      if (!this.cropMode) s.clearSelection()
      this.#lastTap = null
      return
    }
    const clip = press.hit.placed.clip
    const now = performance.now()
    if (
      clip.type === 'text' &&
      this.#lastTap?.clipId === clip.id &&
      now - this.#lastTap.at < DOUBLE_TAP_MS &&
      !press.hit.placed.track.locked
    ) {
      this.#lastTap = null
      this.#cb.onEditText(clip.id)
      return
    }
    this.#lastTap = { clipId: clip.id, at: now }
  }

  #onCancel = (e: PointerEvent): void => {
    if (!this.#pointers.has(e.pointerId)) return
    this.#pointers.delete(e.pointerId)
    this.#press = null
    this.#cancelGesture()
  }

  #onLost = (e: PointerEvent): void => {
    if (this.#pointers.has(e.pointerId)) this.#onCancel(e)
  }

  #onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') this.#shift = true
    if (e.key === 'Alt') this.#alt = true
    if (e.key !== 'Escape' || !this.#gesture) return
    e.preventDefault()
    e.stopPropagation()
    this.#cancelGesture()
  }

  #onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') this.#shift = false
    if (e.key === 'Alt') this.#alt = false
  }

  /* ------------------------------------------------------------------ gestures */

  #startTransform(
    kind: 'move' | 'scale' | 'rotate' | 'pinch',
    at: { placed: Placed; pose: Pose },
    p0?: Array<[number, number]>,
    ids?: number[],
  ): void {
    const s = this.store.getState()
    if (!s.project) return
    if (at.placed.track.locked) {
      toast('Track is locked')
      return
    }
    if (kind === 'pinch') {
      ids = [...this.#pointers.keys()].slice(0, 2)
      p0 = ids.map((id) => {
        const p = this.#pointers.get(id)!
        return this.#canvasPoint(p.x, p.y)
      })
    }
    s.setPlaying(false)
    const tr = at.placed.clip.transform
    const { local } = at.placed
    const v0 = {
      x: valueAt(tr.x, local),
      y: valueAt(tr.y, local),
      scale: valueAt(tr.scale, local),
      rotation: valueAt(tr.rotation, local),
    }
    const fps = s.project.settings.fps
    this.#gesture = {
      kind,
      placed: at.placed,
      base: s.project,
      pose: at.pose,
      v0,
      keyT: clamp(snapToFrame(local, fps), 0, at.placed.clip.duration),
      p0: p0 ?? [],
      ids: ids ?? [],
      values: v0,
      guides: [],
      snapped: '',
    }
    if (kind === 'move') this.els.root.dataset.moving = 'true'
    this.requestFrame()
  }

  #startCrop(at: { placed: Placed; pose: Pose }, handle: CropHandle, id: number): void {
    const clip = at.placed.clip
    if (clip.type !== 'video' && clip.type !== 'image') return
    if (at.placed.track.locked) {
      toast('Track is locked')
      return
    }
    this.store.getState().setPlaying(false)
    const full = fullFrame(at.pose, clip.crop)
    this.#gesture = {
      kind: 'crop',
      placed: at.placed,
      full,
      crop0: clip.crop,
      crop: clip.crop,
      handle,
      id,
    }
    this.requestFrame()
  }

  /** Recomputes the gesture result from the current pointers. */
  #update(): void {
    const g = this.#gesture
    if (!g) return
    if (g.kind === 'crop') {
      const p = this.#pointers.get(g.id)
      if (!p) return
      const [x, y] = this.#canvasPoint(p.x, p.y)
      g.crop = dragCrop(g.full, g.crop0, g.handle, x, y)
      return
    }
    const pts = g.ids.map((id) => {
      const p = this.#pointers.get(id)
      return p ? this.#canvasPoint(p.x, p.y) : undefined
    })
    if (pts.some((p) => !p)) return
    const cur = pts as Array<[number, number]>
    const v = { ...g.v0 }
    const threshold = SNAP_PX / (this.k || 1)
    let guides: Guide[] = []
    const snaps: string[] = []
    const { pose } = g
    if (g.kind === 'move' || g.kind === 'pinch') {
      let dx: number
      let dy: number
      if (g.kind === 'pinch') {
        const d = pinchDelta(g.p0[0]!, g.p0[1]!, cur[0]!, cur[1]!)
        dx = d.dx
        dy = d.dy
        const sc = snapScale(clamp(g.v0.scale * d.scale, MIN_SCALE, MAX_SCALE), 0.02)
        v.scale = sc.value
        if (sc.snapped) snaps.push('scale')
        const rot = snapAngle(g.v0.rotation + d.rotation, { tol: 3 })
        v.rotation = rot.value
        if (rot.snapped) snaps.push(`rot${rot.value}`)
      } else {
        dx = cur[0]![0] - g.p0[0]![0]
        dy = cur[0]![1] - g.p0[0]![1]
      }
      if (!this.#alt) {
        // Snap the pose as it will be drawn (scaled about its centre for a pinch).
        const f = v.scale / (g.v0.scale || 1)
        const s = snapMove({ ...pose, w: pose.w * f, h: pose.h * f }, dx, dy, threshold)
        dx = s.dx
        dy = s.dy
        guides = s.guides
        for (const gd of guides) snaps.push(`${gd.axis}${gd.at}`)
      }
      v.x = g.v0.x + dx
      v.y = g.v0.y + dy
    } else if (g.kind === 'scale') {
      const [x0, y0] = g.p0[0]!
      const [x, y] = cur[0]!
      const sc = snapScale(
        clamp(g.v0.scale * cornerScale(pose.cx, pose.cy, x0, y0, x, y), MIN_SCALE, MAX_SCALE),
      )
      v.scale = sc.value
      if (sc.snapped) snaps.push('scale')
    } else {
      const [x0, y0] = g.p0[0]!
      const [x, y] = cur[0]!
      const delta = angleOf(pose.cx, pose.cy, x, y) - angleOf(pose.cx, pose.cy, x0, y0)
      const rot = snapAngle(g.v0.rotation + delta, this.#shift ? { step: 15 } : {})
      v.rotation = rot.value
      if (rot.snapped && !this.#shift) snaps.push(`rot${rot.value}`)
    }
    const key = snaps.join('|')
    if (key && key !== g.snapped) haptic(HAPTIC_SNAP)
    g.snapped = key
    g.values = v
    g.guides = guides
  }

  /** Properties the gesture changed (unchanged ones get no keyframe). */
  #changed(g: Gesture): Partial<TransformValues> {
    if (g.kind === 'crop') return {}
    const out: Partial<TransformValues> = {}
    for (const prop of ['x', 'y', 'scale', 'rotation'] as const) {
      if (Math.abs(g.values[prop] - g.v0[prop]) > EPS[prop]) out[prop] = g.values[prop]
    }
    return out
  }

  #commitGesture(): void {
    const g = this.#gesture
    if (!g) return
    this.#update()
    this.#gesture = null
    delete this.els.root.dataset.moving
    const id = g.placed.clip.id
    const s = this.store.getState()
    try {
      if (g.kind === 'crop') {
        const c = g.crop
        const c0 = g.crop0
        if (
          c.left !== c0.left ||
          c.top !== c0.top ||
          c.right !== c0.right ||
          c.bottom !== c0.bottom
        )
          s.dispatch('Crop', (d) => applyCrop(d, id, c))
      } else {
        const values = this.#changed(g)
        const keys = Object.keys(values)
        if (keys.length) {
          const label =
            g.kind === 'pinch'
              ? 'Transform'
              : g.kind === 'move'
                ? 'Move'
                : g.kind === 'scale'
                  ? 'Scale'
                  : 'Rotate'
          s.dispatch(label, (d) => applyTransform(d, id, values, g.keyT))
        }
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { tone: 'error' })
    }
    setPreviewOverride(null)
    this.requestFrame()
  }

  #cancelGesture(): void {
    if (!this.#gesture) return
    this.#gesture = null
    if (this.els) delete this.els.root.dataset.moving
    setPreviewOverride(null)
    this.requestFrame()
  }

  /* ------------------------------------------------------------------ frame */

  #onStore(s: EditorStore, prev: EditorStore): void {
    if (
      s.project !== prev.project ||
      s.selection !== prev.selection ||
      s.playhead !== prev.playhead ||
      s.assets !== prev.assets
    )
      this.requestFrame()
  }

  requestFrame(): void {
    if (!this.#raf && this.els) this.#raf = requestAnimationFrame(this.#frame)
  }

  #frame = (): void => {
    this.#raf = 0
    this.flush()
  }

  /** Recomputes and paints synchronously (tests call it directly). */
  flush(): void {
    if (!this.els) return
    const t0 = perfStart()
    this.#flush()
    perfEnd(this.#gesture ? 'ov:gesture-frame' : 'ov:frame', t0)
  }

  #flush(): void {
    const g = this.#gesture
    let shown: { placed: Placed; pose: Pose } | undefined
    if (g && g.kind !== 'crop') {
      this.#update()
      const values = this.#changed(g)
      const preview = produce(g.base, (d) => applyTransform(d, g.placed.clip.id, values, g.keyT))
      setPreviewOverride(preview)
      shown = this.selectedNow(preview) ?? this.#poseIn(preview, g.placed)
    } else {
      if (g?.kind === 'crop') this.#update()
      shown = this.selectedNow()
    }
    this.#paintFrame(g?.kind === 'crop' || this.cropMode ? undefined : shown)
    this.#paintGuides(g && g.kind !== 'crop' ? g.guides : [])
    this.#paintCrop(this.cropMode ? shown : undefined, g?.kind === 'crop' ? g : undefined)
    this.#paintBadge(g, shown)
  }

  #poseIn(project: Project, placed: Placed) {
    for (const t of project.tracks) {
      const clip = t.clips.find((c) => c.id === placed.clip.id)
      if (clip && clip.type !== 'audio') {
        const p = { ...placed, clip, track: t } as Placed
        return { placed: p, pose: poseOf(p, this.store.getState().assets, this.#stickerSize) }
      }
    }
    return undefined
  }

  #place(el: HTMLElement, pose: Pose): void {
    const k = this.k
    const w = pose.w * k
    const h = pose.h * k
    el.style.width = `${w}px`
    el.style.height = `${h}px`
    el.style.transform = `translate3d(${pose.cx * k - w / 2}px,${pose.cy * k - h / 2}px,0) rotate(${pose.rotation}deg)`
    // A frame touching the top of the preview keeps its rotate handle inside the canvas: above
    // it the handle would cover the top bar (Undo/Redo) on phones.
    if (pose.cy * k - h / 2 < ROT_HANDLE_ROOM) el.dataset.rotIn = ''
    else delete el.dataset.rotIn
  }

  #paintFrame(at: { placed: Placed; pose: Pose } | undefined): void {
    const f = this.els.frame
    if (!at || this.k === 0) {
      f.hidden = true
      delete f.dataset.clipId
      return
    }
    f.hidden = false
    f.dataset.clipId = at.placed.clip.id
    f.dataset.clipType = at.placed.clip.type
    if (at.placed.track.locked) f.dataset.locked = 'true'
    else delete f.dataset.locked
    this.#place(f, at.pose)
  }

  #paintGuides(guides: readonly Guide[]): void {
    const k = this.k
    const gx = guides.find((g) => g.axis === 'x')
    const gy = guides.find((g) => g.axis === 'y')
    this.els.guideX.hidden = !gx
    this.els.guideY.hidden = !gy
    if (gx) {
      this.els.guideX.style.transform = `translate3d(${gx.at * k}px,0,0)`
      this.els.guideX.dataset.kind = gx.kind
    }
    if (gy) {
      this.els.guideY.style.transform = `translate3d(0,${gy.at * k}px,0)`
      this.els.guideY.dataset.kind = gy.kind
    }
  }

  #paintCrop(
    at: { placed: Placed; pose: Pose } | undefined,
    g: Extract<Gesture, { kind: 'crop' }> | undefined,
  ): void {
    const { cropFull, cropRect: rectEl } = this.els
    const clip = at?.placed.clip
    if (!at || !clip || (clip.type !== 'video' && clip.type !== 'image')) {
      cropFull.hidden = true
      return
    }
    const crop = g?.crop ?? clip.crop
    const full = g?.full ?? fullFrame(at.pose, clip.crop)
    cropFull.hidden = false
    cropFull.dataset.clipId = clip.id
    this.#place(cropFull, full)
    const r = cropRect(crop, full.flipH, full.flipV)
    rectEl.style.left = `${r.left * 100}%`
    rectEl.style.top = `${r.top * 100}%`
    rectEl.style.right = `${r.right * 100}%`
    rectEl.style.bottom = `${r.bottom * 100}%`
    // Handles are drawn at displayed sides; flips swap which model side they control.
    for (const h of rectEl.querySelectorAll<HTMLElement>('[data-crop-at]')) {
      const sides = (h.dataset.cropAt ?? '').split(',') as CropSide[]
      h.dataset.crop = sides
        .map((side) =>
          full.flipH && (side === 'left' || side === 'right')
            ? side === 'left'
              ? 'right'
              : 'left'
            : full.flipV && (side === 'top' || side === 'bottom')
              ? side === 'top'
                ? 'bottom'
                : 'top'
              : side,
        )
        .join(',')
    }
  }

  #paintBadge(g: Gesture | null, at: { placed: Placed; pose: Pose } | undefined): void {
    const b = this.els.badge
    let text: string | null = null
    if (g?.kind === 'scale' || g?.kind === 'pinch') text = `${Math.round(g.values.scale * 100)}%`
    if (g?.kind === 'rotate') text = `${Math.round(g.values.rotation)}°`
    if (g?.kind === 'pinch' && Math.abs(g.values.rotation - g.v0.rotation) > 0.5)
      text = `${text} · ${Math.round(g.values.rotation)}°`
    if (g?.kind === 'crop') {
      const c = g.crop
      text = `${Math.round((1 - c.left - c.right) * 100)}% × ${Math.round((1 - c.top - c.bottom) * 100)}%`
    }
    if (!text || !at) {
      b.hidden = true
      return
    }
    b.hidden = false
    if (b.textContent !== text) b.textContent = text
    const k = this.k
    b.style.transform = `translate3d(${at.pose.cx * k}px,${Math.max(4, (at.pose.cy - at.pose.h / 2) * k - 28)}px,0) translateX(-50%)`
  }
}

export type { Gesture }
