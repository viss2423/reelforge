/**
 * Pointer drag sessions: scrub, move and trim. A session keeps its transient state in plain
 * fields, recomputes it on every pointer move (pure maths only) and writes visuals in the
 * view's animation frame with CSS transforms on the existing clip elements — React does not
 * re-render during the drag. `commit()` performs ONE store dispatch (one undo step, one
 * autosave); `cancel()` (Escape / pointercancel) restores everything.
 */
import {
  fromFrame,
  minClipDuration,
  moveClip,
  snapToFrame,
  trimClip,
  type Asset,
  type Project,
  type Track,
} from '@reelforge/core'
import { haptic } from '@/lib/haptics.ts'
import { locateClip, mainTrackOf, type EditorStoreApi } from '@/state/index.ts'
import { runEdit, trackAccepts } from './commands.ts'
import {
  AUTOSCROLL_EDGE,
  AUTOSCROLL_MAX_SPEED,
  HAPTIC_SNAP,
  RULER_HEIGHT,
  SNAP_PX_MOUSE,
  SNAP_PX_TOUCH,
} from './constants.ts'
import {
  autoScrollSpeed,
  clampGroupDelta,
  clampTrim,
  freeNeighbours,
  reorderBoundary,
  reorderIndex,
  reorderLayout,
  sourceHeadroom,
  trimRange,
  type TrimLimits,
} from './dragMath.ts'
import { contentEnd, mainSpans, rowAt, timeToX, trackSpans, type Row } from './geometry.ts'
import type { Hit } from './hitTest.ts'
import { perfEnd, perfStart } from './perf.ts'
import { SnapIndex, collectSnapTargets, type SnapTarget } from './snapping.ts'
import type { Session, TimelineView } from './view.ts'

export interface PointerPos {
  clientX: number
  clientY: number
}

export interface SessionContext {
  view: TimelineView
  store: EditorStoreApi
  rows: readonly Row[]
  touch: boolean
  rect: { left: number; top: number }
}

type ClipHit = Extract<Hit, { kind: 'clip' }>

/** Shared plumbing: pointer tracking, snapping threshold, haptic tick on new snaps. */
abstract class BaseSession implements Session {
  protected readonly ctx: SessionContext
  protected readonly project: Project
  protected readonly fps: number
  protected last: PointerPos
  protected snap: SnapTarget | null = null

  constructor(ctx: SessionContext, p: PointerPos) {
    this.ctx = ctx
    this.project = ctx.store.getState().project!
    this.fps = this.project.settings.fps
    this.last = p
  }

  protected get threshold(): number {
    return (this.ctx.touch ? SNAP_PX_TOUCH : SNAP_PX_MOUSE) / this.ctx.view.ppu
  }

  protected point() {
    return this.ctx.view.point(this.last.clientX, this.last.clientY, this.ctx.rect)
  }

  /** Records the snap target; a tick of haptics when it snaps to something new. */
  protected setSnap(target: SnapTarget | null): void {
    if (target && (this.snap?.t !== target.t || this.snap.kind !== target.kind)) haptic(HAPTIC_SNAP)
    this.snap = target
  }

  move(p: PointerPos): void {
    const t0 = perfStart()
    this.last = p
    this.update()
    this.ctx.view.invalidateSession()
    perfEnd('tl:pointermove', t0)
  }

  refresh(): void {
    this.update()
    this.ctx.view.invalidateSession()
  }

  autoScroll(): number {
    const vx = this.last.clientX - this.ctx.rect.left
    return autoScrollSpeed(vx, this.ctx.view.width, AUTOSCROLL_EDGE, AUTOSCROLL_MAX_SPEED)
  }

  protected abstract update(): void
  abstract render(): void
  /** Applies the result (one dispatch). The view session must already be ended. */
  abstract commit(): void
  /** Restores the pre-drag state. */
  abstract cancel(): void
}

/* ------------------------------------------------------------------ scrub */

/** Ruler / playhead scrubbing: frame-snapped, magnetic to clip edges and markers. */
export class ScrubSession extends BaseSession {
  readonly #index: SnapIndex
  readonly #origin: number
  readonly #end: number
  #t = 0

  constructor(ctx: SessionContext, p: PointerPos) {
    super(ctx, p)
    const s = ctx.store.getState()
    s.setPlaying(false)
    this.#origin = s.playhead
    this.#end = contentEnd(this.project)
    this.#index = new SnapIndex(collectSnapTargets(this.project, { playhead: Number.NaN }))
    this.update()
    // Seek immediately on press (tap-to-seek), then follow the pointer per frame.
    s.setPlayhead(this.#t)
  }

  get time(): number {
    return this.#t
  }

  protected update(): void {
    const raw = Math.min(this.#end, Math.max(0, this.point().t))
    const target = this.#index.nearest(raw, this.threshold)
    this.setSnap(target)
    this.#t = snapToFrame(target ? target.t : raw, this.fps)
  }

  render(): void {
    this.ctx.store.getState().setPlayhead(this.#t)
    this.ctx.view.setGuide(this.snap ? this.#t : null, this.snap?.kind ?? null)
  }

  commit(): void {
    this.ctx.store.getState().setPlayhead(this.#t)
  }

  cancel(): void {
    this.ctx.store.getState().setPlayhead(this.#origin)
  }
}

/* ------------------------------------------------------------------ move */

interface MoveItem {
  id: string
  track: Track
  start: number
  duration: number
}

/** Elements this session styled, so cleanup touches exactly those. */
class Touched {
  readonly #els = new Set<HTMLElement>()

  transform(el: HTMLElement, value: string, attr?: string): void {
    el.style.transform = value
    if (attr) el.dataset[attr] = 'true'
    this.#els.add(el)
  }

  remember(el: HTMLElement): void {
    this.#els.add(el)
  }

  reset(): void {
    for (const el of this.#els) {
      el.style.transform = ''
      delete el.dataset.dragging
      delete el.dataset.shifting
      delete el.dataset.lifted
      delete el.dataset.invalid
    }
    this.#els.clear()
  }
}

/**
 * Clip move. Main track: magnetic reorder with an insertion indicator and the other clips
 * rippling out of the way. Other tracks: free move (frame-snapped, magnetic to edges,
 * playhead, markers and beats) and cross-track moves to compatible tracks. Several selected
 * free-track clips move together.
 */
export class MoveSession extends BaseSession {
  readonly #primary: ClipHit
  readonly #items: MoveItem[]
  readonly #index: SnapIndex
  readonly #grab: number
  readonly #sourceRow: Row | undefined
  readonly #main: Track | undefined
  readonly #touched = new Touched()
  #target: Track
  #delta = 0
  #reorder = -1
  #layoutKey = ''
  #preview: Float64Array | null = null

  constructor(ctx: SessionContext, hit: ClipHit, p: PointerPos) {
    super(ctx, p)
    this.#primary = hit
    this.#main = mainTrackOf(this.project)
    this.#target = hit.track
    this.#grab = hit.t - hit.start
    this.#sourceRow = ctx.rows.find((r) => r.type === 'track' && r.track.id === hit.track.id)
    const sel = ctx.store.getState().selection.clipIds
    const group =
      hit.track.kind !== 'main' && sel.length > 1 && sel.includes(hit.clip.id)
        ? sel
            .map((id) => locateClip(this.project, id))
            .filter((l) => l !== undefined && l.track.kind !== 'main' && !l.track.locked)
        : []
    this.#items = group.length
      ? group.map((l) => ({
          id: l!.clip.id,
          track: l!.track,
          start: l!.clip.start,
          duration: l!.clip.duration,
        }))
      : [{ id: hit.clip.id, track: hit.track, start: hit.start, duration: hit.end - hit.start }]
    this.#index = new SnapIndex(
      collectSnapTargets(this.project, {
        playhead: ctx.store.getState().playhead,
        exclude: new Set(this.#items.map((i) => i.id)),
      }),
    )
    this.update()
  }

  /** Ids of the clips being moved. */
  get ids(): string[] {
    return this.#items.map((i) => i.id)
  }

  get target(): Track {
    return this.#target
  }

  get reorderTarget(): number {
    return this.#reorder
  }

  get delta(): number {
    return this.#delta
  }

  protected update(): void {
    const pt = this.point()
    const clip = this.#primary.clip
    // Target track: the row under the pointer when it accepts the clip (single clip only).
    let target = this.#primary.track
    if (this.#items.length === 1) {
      const row = this.ctx.rows[rowAt(this.ctx.rows, pt.y, true)]
      if (row?.type === 'track' && !row.track.locked && trackAccepts(row.track.kind, clip.type))
        target = row.track
    }
    this.#target = target
    if (target.kind === 'main') {
      this.setSnap(null)
      this.#reorder = reorderIndex(
        target.clips.map((c) => c.duration),
        this.#primary.track.kind === 'main' ? this.#primary.index : -1,
        pt.t,
      )
      this.#delta = pt.t - this.#grab - this.#primary.start
      return
    }
    this.#reorder = -1
    const starts = this.#items.map((i) => i.start)
    let lo = Infinity
    let hi = -Infinity
    for (const i of this.#items) {
      lo = Math.min(lo, i.start)
      hi = Math.max(hi, i.start + i.duration)
    }
    const raw = pt.t - this.#grab - this.#primary.start
    const hit = this.#index.snapEdges([lo + raw, hi + raw], this.threshold)
    this.setSnap(hit?.target ?? null)
    const delta = clampGroupDelta(starts, raw + (hit?.delta ?? 0))
    // Frame-accurate: the primary clip's new start lands on the frame grid.
    const primaryStart = this.#primary.start
    this.#delta = snapToFrame(primaryStart + delta, this.fps) - primaryStart
    this.ctx.view.extraEndUs = hi + this.#delta
  }

  /** Main-track preview starts (by original index) for the current reorder state. */
  #mainPreview(): Float64Array | null {
    const main = this.#main
    if (!main) return null
    const fromMain = this.#primary.track.kind === 'main'
    const toMain = this.#target.kind === 'main'
    if (!fromMain && !toMain) return null
    const key = `${fromMain}:${toMain}:${this.#reorder}`
    if (key === this.#layoutKey) return this.#preview
    this.#layoutKey = key
    if (fromMain && toMain)
      this.#preview = reorderLayout(main.clips, this.#primary.index, this.#reorder)
    else if (fromMain) {
      // Leaving the main track: the gap closes.
      const rest = main.clips.filter((_, i) => i !== this.#primary.index)
      const s = mainSpans(rest)
      const out = new Float64Array(main.clips.length)
      for (let i = 0, k = 0; i < main.clips.length; i++)
        out[i] = i === this.#primary.index ? 0 : s.starts[k++]!
      this.#preview = out
    } else {
      // Arriving from another track: a gap the size of the clip opens at the index.
      const s = trackSpans(main)
      const out = new Float64Array(main.clips.length)
      for (let i = 0; i < main.clips.length; i++)
        out[i] = s.starts[i]! + (i >= this.#reorder ? this.#items[0]!.duration : 0)
      this.#preview = out
    }
    return this.#preview
  }

  render(): void {
    const { view, rows } = this.ctx
    const ppu = view.ppu
    const touched = this.#touched
    touched.reset()
    const targetRow = rows.find((r) => r.type === 'track' && r.track.id === this.#target.id)
    const dy = targetRow && this.#sourceRow ? targetRow.y - this.#sourceRow.y : 0
    for (const item of this.#items) {
      const el = view.clipEls.get(item.id)
      if (!el) continue
      touched.transform(el, `translate3d(${this.#delta * ppu}px,${dy}px,0)`, 'dragging')
    }
    // Ripple the main track around the dragged clip.
    const preview = this.#mainPreview()
    const main = this.#main
    if (preview && main) {
      const spans = trackSpans(main)
      for (let i = 0; i < main.clips.length; i++) {
        const c = main.clips[i]!
        if (c.id === this.#primary.clip.id) continue
        const el = view.clipEls.get(c.id)
        if (!el) continue
        const dx = (preview[i]! - spans.starts[i]!) * ppu
        touched.transform(el, dx ? `translate3d(${dx}px,0,0)` : '', 'shifting')
      }
    }
    if (this.#reorder >= 0 && targetRow && main) {
      const fromMain = this.#primary.track.kind === 'main'
      const t = reorderBoundary(
        main.clips.map((c) => c.duration),
        fromMain ? this.#primary.index : -1,
        this.#reorder,
      )
      view.setIndicator(t, targetRow.y, targetRow.height)
    } else view.setIndicator(null)
    view.setGuide(this.snap ? this.snap.t : null, this.snap?.kind ?? null)
  }

  /** True when releasing now would change the project. */
  get changed(): boolean {
    const p = this.#primary
    if (this.#target.kind === 'main') {
      return p.track.kind !== 'main' || this.#reorder !== p.index
    }
    return this.#target.id !== p.track.id || this.#delta !== 0
  }

  commit(): void {
    this.#touched.reset()
    if (!this.changed) return
    const p = this.#primary
    const { store } = this.ctx
    const target = this.#target
    if (target.kind === 'main') {
      const index = this.#reorder
      runEdit(store, 'Move clip', (d) =>
        moveClip(d, p.clip.id, p.track.kind === 'main' ? { index } : { trackId: target.id, index }),
      )
      return
    }
    if (this.#items.length === 1) {
      const start = snapToFrame(Math.max(0, p.start + this.#delta), this.fps)
      runEdit(store, 'Move clip', (d) =>
        moveClip(
          d,
          p.clip.id,
          target.id === p.track.id ? { start } : { trackId: target.id, start },
        ),
      )
      return
    }
    // Group: move in the direction of travel first so clips never pass through each other.
    const delta = this.#delta
    const order = this.#items.toSorted((a, b) =>
      delta > 0 ? b.start - a.start : a.start - b.start,
    )
    runEdit(store, `Move ${order.length} clips`, (d) => {
      for (const it of order) moveClip(d, it.id, { start: Math.max(0, it.start + delta) })
    })
  }

  cancel(): void {
    this.#touched.reset()
  }
}

/* ------------------------------------------------------------------ trim */

const ceilToFrame = (t: number, fps: number) =>
  fromFrame(Math.ceil((t * fps) / 1_000_000 - 1e-9), fps)
const floorToFrame = (t: number, fps: number) =>
  fromFrame(Math.floor((t * fps) / 1_000_000 + 1e-9), fps)

/**
 * Trim either edge. Limits: one frame minimum, neighbours on free tracks, and the asset's
 * available source. On the main track trims ripple: the preview keeps the clip's slot and
 * shifts later clips, exactly as the magnetic track will look after the commit.
 */
export class TrimSession extends BaseSession {
  readonly #hit: ClipHit
  readonly #edge: 'start' | 'end'
  readonly #limits: TrimLimits
  readonly #index: SnapIndex
  readonly #grab: number
  readonly #touched = new Touched()
  readonly #asset: Asset | undefined
  #value: number

  constructor(ctx: SessionContext, hit: ClipHit, p: PointerPos, asset: Asset | undefined) {
    super(ctx, p)
    this.#hit = hit
    this.#asset = asset
    this.#edge = hit.zone === 'trim-start' ? 'start' : 'end'
    const main = hit.track.kind === 'main'
    const nb = main
      ? { lo: -Infinity, hi: Infinity }
      : freeNeighbours(trackSpans(hit.track), hit.index)
    this.#limits = {
      edge: this.#edge,
      start: hit.start,
      end: hit.end,
      minDuration: minClipDuration(this.fps),
      lo: nb.lo,
      hi: nb.hi,
      headroom: sourceHeadroom(hit.clip, asset),
    }
    const edgeTime = this.#edge === 'start' ? hit.start : hit.end
    this.#grab = this.point().t - edgeTime
    this.#value = edgeTime
    this.#index = new SnapIndex(
      collectSnapTargets(this.project, {
        playhead: ctx.store.getState().playhead,
        exclude: new Set([hit.clip.id]),
      }),
    )
  }

  /** New playback span of the clip. */
  get span(): { start: number; end: number } {
    return this.#edge === 'start'
      ? { start: this.#value, end: this.#hit.end }
      : { start: this.#hit.start, end: this.#value }
  }

  protected update(): void {
    const proposed = this.point().t - this.#grab
    const target = this.#index.nearest(proposed, this.threshold)
    const clamped = clampTrim(target ? target.t : proposed, this.#limits)
    // Only report the snap when the clamp did not pull the edge away from it.
    this.setSnap(target && clamped === target.t ? target : null)
    const r = trimRange(this.#limits)
    let v = snapToFrame(clamped, this.fps)
    if (v < r.min) v = ceilToFrame(r.min, this.fps)
    if (v > r.max) v = floorToFrame(r.max, this.fps)
    // A range narrower than a frame (or a non-frame-aligned bound) keeps the exact clamp.
    this.#value = v < r.min || v > r.max ? clamped : v
    if (this.#edge === 'end') this.ctx.view.extraEndUs = this.#value
  }

  render(): void {
    const { view } = this.ctx
    const ppu = view.ppu
    const hit = this.#hit
    const { start, end } = this.span
    this.#touched.reset()
    const el = view.clipEls.get(hit.clip.id)
    const main = hit.track.kind === 'main'
    if (el) {
      const headCut = (start - hit.start) * ppu
      // Free tracks move the left edge; the magnetic main track keeps the slot (ripple).
      const left = timeToX(main ? hit.start : start, ppu)
      el.style.left = `${left}px`
      el.style.width = `${Math.max(2, (end - start) * ppu)}px`
      el.dataset.dragging = 'true'
      this.#touched.remember(el)
      const media = el.querySelector<HTMLElement>('[data-clip-media]')
      if (media) this.#touched.transform(media, `translate3d(${-headCut}px,0,0)`)
    }
    if (main) {
      const dDur = (end - start - (hit.end - hit.start)) * ppu
      for (let i = hit.index + 1; i < hit.track.clips.length; i++) {
        const other = view.clipEls.get(hit.track.clips[i]!.id)
        if (other) this.#touched.transform(other, dDur ? `translate3d(${dDur}px,0,0)` : '')
      }
    }
    const row = this.ctx.rows.find((r) => r.type === 'track' && r.track.id === hit.track.id)
    const shownStart = main ? hit.start : start
    const edgeT = this.#edge === 'start' ? shownStart : shownStart + (end - start)
    view.setBadge(
      `${((end - start) / 1_000_000).toFixed(2)}s`,
      view.viewportXOf(edgeT) + (this.#edge === 'end' ? -64 : 4),
      RULER_HEIGHT + (row ? row.y - view.scrollY : 0) - 22,
    )
    view.setGuide(this.snap ? this.snap.t : null, this.snap?.kind ?? null)
  }

  #restore(): void {
    const el = this.ctx.view.clipEls.get(this.#hit.clip.id)
    if (el) {
      // Back to the geometry React rendered, so an unchanged commit leaves no residue.
      const ppu = this.ctx.view.ppu
      el.style.left = `${timeToX(this.#hit.start, ppu)}px`
      el.style.width = `${Math.max(2, (this.#hit.end - this.#hit.start) * ppu)}px`
    }
    this.#touched.reset()
  }

  get changed(): boolean {
    const { start, end } = this.span
    return start !== this.#hit.start || end !== this.#hit.end
  }

  commit(): void {
    this.#restore()
    if (!this.changed) return
    const id = this.#hit.clip.id
    const edges = this.#edge === 'start' ? { start: this.#value } : { end: this.#value }
    const asset = this.#asset
    // Core re-checks the extension against the asset's duration (the authoritative bound).
    runEdit(this.ctx.store, 'Trim clip', (d) =>
      asset ? trimClip(d, id, edges, { asset }) : trimClip(d, id, edges),
    )
  }

  cancel(): void {
    this.#restore()
  }
}
