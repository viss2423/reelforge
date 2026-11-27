/**
 * Pro edit sessions: slip (move a clip's content inside its fixed span, with a filmstrip of
 * the whole source), roll (move the cut between two main-track clips) and marquee
 * selection. Like the other sessions they keep transient state in fields, paint in the
 * view's animation frame with styles on existing elements and commit ONE dispatch.
 */
import {
  rollEdit,
  rollLimits,
  slipClip,
  slipLimits,
  snapToFrame,
  sourceSpan,
  type Asset,
  type Clip,
} from '@reelforge/core'
import { api } from '@/api/index.ts'
import { runEdit } from './commands.ts'
import { RULER_HEIGHT } from './constants.ts'
import { timeToX, trackSpans } from './geometry.ts'
import { boxFrom, clipsInBox, type Hit } from './hitTest.ts'
import { peekThumbs } from './media.ts'
import { BaseSession, Touched, type PointerPos, type SessionContext } from './sessions.ts'
import { SnapIndex, collectSnapTargets } from './snapping.ts'

type ClipHit = Extract<Hit, { kind: 'clip' }>

const seconds = (us: number): string => `${us >= 0 ? '+' : '−'}${(Math.abs(us) / 1e6).toFixed(2)}s`

/* ------------------------------------------------------------------ slip */

/** Whether a clip has source time to slip. */
export const canSlip = (clip: Clip): boolean => clip.type === 'video' || clip.type === 'audio'

/** Ghost filmstrip width cap, in viewport widths on each side of the clip. */
const GHOST_REACH = 1.5

/**
 * Slip: dragging moves the clip's CONTENT (in-point) while its position and length stay.
 * A ghost strip shows the whole available source around the clip, the clip window at full
 * brightness and the hidden source dimmed on both sides.
 */
export class SlipSession extends BaseSession {
  readonly #hit: ClipHit
  readonly #asset: Asset | undefined
  /** Average source µs per timeline µs (speed, ramps averaged). */
  readonly #rate: number
  /** +1 forward, −1 reversed (content moves the other way in source). */
  readonly #dir: number
  readonly #limits: { min: number; max: number }
  readonly #grabT: number
  readonly #touched = new Touched()
  /** Ghost geometry relative to the clip's playback start (µs). */
  #ghost: { from: number; to: number } | null = null
  #source = 0

  constructor(ctx: SessionContext, hit: ClipHit, p: PointerPos, asset: Asset | undefined) {
    super(ctx, p)
    this.#hit = hit
    this.#asset = asset
    const clip = hit.clip
    const timed = clip.type === 'video' || clip.type === 'audio'
    this.#rate = timed ? Math.max(1e-6, sourceSpan(clip) / clip.duration) : 1
    this.#dir = clip.type === 'video' && clip.reverse ? -1 : 1
    this.#limits = slipLimits(clip, asset)
    this.#grabT = this.point().t
    this.#buildGhost()
  }

  /** Applied source delta (µs). */
  get source(): number {
    return this.#source
  }

  override autoScroll(): number {
    // The clip stays put: slipping never scrolls the timeline.
    return 0
  }

  protected update(): void {
    const dt = snapToFrame(this.point().t - this.#grabT, this.fps)
    // Content moving right by dt shows earlier source (later when reversed).
    const raw = -dt * this.#rate * this.#dir
    this.#source = Math.round(Math.min(this.#limits.max, Math.max(this.#limits.min, raw))) || 0
  }

  /** Timeline offset (µs) the content moved by for the current source delta. */
  get #shift(): number {
    return (-this.#source / this.#rate) * this.#dir
  }

  #buildGhost(): void {
    const ghost = this.ctx.view.els.ghost
    const clip = this.#hit.clip
    if (!ghost || (clip.type !== 'video' && clip.type !== 'audio')) return
    const { view } = this.ctx
    const ppu = view.ppu
    const dur = this.#hit.end - this.#hit.start
    const reach = (view.width * GHOST_REACH) / ppu
    // Source available before/after the clip, in timeline µs (drag range).
    const before = Math.min(
      reach,
      (this.#dir > 0 ? -this.#limits.min : this.#limits.max) / this.#rate,
    )
    const after = Math.min(
      reach,
      (this.#dir > 0 ? this.#limits.max : -this.#limits.min) / this.#rate,
    )
    // The ghost covers the available source, in clip time with the content where it is now.
    const from = -before
    const to = dur + after
    this.#ghost = { from, to }
    const row = this.ctx.rows.find((r) => r.type === 'track' && r.track.id === this.#hit.track.id)
    const height = row?.height ?? 40
    ghost.replaceChildren()
    ghost.style.width = `${(to - from) * ppu}px`
    ghost.style.height = `${height}px`
    ghost.dataset.kind = clip.type
    const thumbs = clip.type === 'video' ? peekThumbs(clip.assetId) : null
    if (thumbs) {
      const scale = height / thumbs.tileHeight
      const slot = Math.max(8, thumbs.tileWidth * scale)
      const image = `url("${api.thumbsUrl(clip.assetId)}")`
      const size = `${thumbs.columns * slot}px ${thumbs.rows * height}px`
      const width = (to - from) * ppu
      for (let x = 0; x < width; x += slot) {
        // Source shown at this ghost x with the content in its ORIGINAL position.
        const local = from + (x + slot / 2) / ppu
        const src =
          this.#dir > 0
            ? clip.in + local * this.#rate
            : clip.in + sourceSpan(clip) - local * this.#rate
        const tile = Math.min(thumbs.count - 1, Math.max(0, Math.round(src / thumbs.interval)))
        const el = document.createElement('div')
        el.style.cssText = `position:absolute;top:0;left:${x}px;width:${slot}px;height:${height}px;background-image:${image};background-size:${size};background-position:${-(tile % thumbs.columns) * slot}px ${-Math.floor(tile / thumbs.columns) * height}px`
        ghost.append(el)
      }
    }
    // Dim masks over the source outside the clip window (positioned in render).
    for (const side of ['l', 'r']) {
      const m = document.createElement('div')
      m.dataset.mask = side
      m.style.cssText = 'position:absolute;top:0;bottom:0;background:rgb(0 0 0 / 0.55)'
      ghost.append(m)
    }
  }

  render(): void {
    const { view, rows } = this.ctx
    const ppu = view.ppu
    const hit = this.#hit
    this.#touched.reset()
    const el = view.clipEls.get(hit.clip.id)
    const media = el?.querySelector<HTMLElement>('[data-clip-media]')
    if (el) {
      el.dataset.dragging = 'true'
      this.#touched.remember(el)
    }
    const ghost = view.els.ghost
    const g = this.#ghost
    const row = rows.find((r) => r.type === 'track' && r.track.id === hit.track.id)
    if (ghost && g && row) {
      if (media) this.#touched.transform(media, 'translate3d(0,0,0)', 'slipping')
      const x0 = view.viewportXOf(hit.start + g.from + this.#shift)
      ghost.hidden = false
      ghost.style.transform = `translate3d(${x0}px,${RULER_HEIGHT + row.y - view.scrollY}px,0)`
      const winL = (hit.start - (hit.start + g.from + this.#shift)) * ppu
      const winR = winL + (hit.end - hit.start) * ppu
      const total = (g.to - g.from) * ppu
      const [l, r] = ghost.querySelectorAll<HTMLElement>('[data-mask]')
      if (l) {
        l.style.left = '0px'
        l.style.width = `${Math.max(0, winL)}px`
      }
      if (r) {
        r.style.left = `${winR}px`
        r.style.width = `${Math.max(0, total - winR)}px`
      }
    } else if (media) {
      // No ghost element: shift the clip's own filmstrip.
      this.#touched.transform(media, `translate3d(${this.#shift * ppu}px,0,0)`)
    }
    view.setBadge(
      `Slip ${seconds(this.#source)}`,
      view.viewportXOf(hit.start) + 4,
      RULER_HEIGHT + (row ? row.y - view.scrollY : 0) - 22,
    )
  }

  #restore(): void {
    this.#touched.reset()
    const ghost = this.ctx.view.els.ghost
    if (ghost) {
      ghost.hidden = true
      ghost.replaceChildren()
    }
  }

  get changed(): boolean {
    return this.#source !== 0
  }

  commit(): void {
    this.#restore()
    if (!this.changed) return
    const id = this.#hit.clip.id
    const delta = this.#source
    const asset = this.#asset
    runEdit(this.ctx.store, 'Slip clip', (d) => {
      slipClip(d, id, delta, asset ? { asset } : undefined)
    })
  }

  cancel(): void {
    this.#restore()
  }
}

/* ------------------------------------------------------------------ roll */

/**
 * Main-track clip whose incoming cut a trim-zone hit touches, or null when the edge is the
 * start of the first clip or the end of the last one (nothing to roll against).
 */
export const rollTarget = (hit: ClipHit): string | null => {
  if (hit.track.kind !== 'main') return null
  const i = hit.zone === 'trim-start' ? hit.index : hit.zone === 'trim-end' ? hit.index + 1 : -1
  if (i < 1 || i >= hit.track.clips.length) return null
  return hit.track.clips[i]!.id
}

/**
 * Roll: drags the cut between two adjacent main clips. The outgoing clip grows (or shrinks)
 * at its tail and the incoming one shrinks (or grows) at its head by the same amount, so the
 * rest of the timeline stays put. Magnetic to the playhead, markers and other clip edges.
 */
export class RollSession extends BaseSession {
  readonly #track: ClipHit['track']
  readonly #rightIndex: number
  readonly #cut: number
  readonly #limits: { min: number; max: number }
  readonly #assets: Readonly<Record<string, Asset>>
  readonly #index: SnapIndex
  readonly #grab: number
  readonly #touched = new Touched()
  readonly #saved = new Map<HTMLElement, { left: string; width: string }>()
  #delta = 0

  constructor(ctx: SessionContext, hit: ClipHit, rightId: string, p: PointerPos) {
    super(ctx, p)
    this.#track = hit.track
    this.#rightIndex = hit.track.clips.findIndex((c) => c.id === rightId)
    const spans = trackSpans(hit.track)
    // The visible cut: the incoming clip's playback start (the middle of any transition).
    this.#cut = spans.starts[this.#rightIndex]! + spans.overlaps[this.#rightIndex]! / 2
    this.#assets = ctx.store.getState().assets
    this.#limits = rollLimits(this.project, rightId, this.#assets)
    const left = hit.track.clips[this.#rightIndex - 1]!
    this.#index = new SnapIndex(
      collectSnapTargets(this.project, {
        playhead: ctx.store.getState().playhead,
        exclude: new Set([left.id, rightId]),
      }),
    )
    this.#grab = this.point().t - this.#cut
  }

  get delta(): number {
    return this.#delta
  }

  protected update(): void {
    const proposed = this.point().t - this.#grab
    const target = this.#index.nearest(proposed, this.threshold)
    const raw = (target ? target.t : proposed) - this.#cut
    const clamped = Math.min(this.#limits.max, Math.max(this.#limits.min, raw))
    this.setSnap(target && clamped === raw ? target : null)
    let d = snapToFrame(clamped, this.fps)
    if (d < this.#limits.min || d > this.#limits.max) d = Math.round(clamped)
    this.#delta = d || 0
  }

  #save(el: HTMLElement): void {
    if (!this.#saved.has(el)) this.#saved.set(el, { left: el.style.left, width: el.style.width })
  }

  render(): void {
    const { view } = this.ctx
    const ppu = view.ppu
    const d = this.#delta * ppu
    const leftClip = this.#track.clips[this.#rightIndex - 1]!
    const rightClip = this.#track.clips[this.#rightIndex]!
    const spans = trackSpans(this.#track)
    this.#touched.reset()
    const l = view.clipEls.get(leftClip.id)
    if (l) {
      this.#save(l)
      const w = (spans.ends[this.#rightIndex - 1]! - spans.starts[this.#rightIndex - 1]!) * ppu
      l.style.width = `${Math.max(2, w + d)}px`
      l.dataset.dragging = 'true'
      this.#touched.remember(l)
    }
    const r = view.clipEls.get(rightClip.id)
    if (r) {
      this.#save(r)
      const s = spans.starts[this.#rightIndex]!
      const w = (spans.ends[this.#rightIndex]! - s) * ppu
      r.style.left = `${timeToX(s, ppu) + d}px`
      r.style.width = `${Math.max(2, w - d)}px`
      r.dataset.dragging = 'true'
      this.#touched.remember(r)
      const media = r.querySelector<HTMLElement>('[data-clip-media]')
      if (media) this.#touched.transform(media, `translate3d(${-d}px,0,0)`)
    }
    const row = this.ctx.rows.find((x) => x.type === 'track' && x.track.id === this.#track.id)
    const cut = this.#cut + this.#delta
    view.setBadge(
      `Roll ${seconds(this.#delta)}`,
      view.viewportXOf(cut) + 4,
      RULER_HEIGHT + (row ? row.y - view.scrollY : 0) - 22,
    )
    view.setGuide(cut, this.snap?.kind ?? 'clip')
  }

  #restore(): void {
    for (const [el, s] of this.#saved) {
      el.style.left = s.left
      el.style.width = s.width
    }
    this.#saved.clear()
    this.#touched.reset()
  }

  commit(): void {
    this.#restore()
    if (this.#delta === 0) return
    const id = this.#track.clips[this.#rightIndex]!.id
    const delta = this.#delta
    const assets = this.#assets
    runEdit(this.ctx.store, 'Roll edit', (d) => {
      rollEdit(d, id, delta, { assets })
    })
  }

  cancel(): void {
    this.#restore()
  }
}

/* ------------------------------------------------------------------ marquee */

/**
 * Box selection (mouse drag on empty lanes, two-finger drag on touch). The selection
 * follows the box live; with `additive` it is added to the selection the drag started
 * with. Escape restores the original selection.
 */
export class MarqueeSession extends BaseSession {
  readonly #origin: { t: number; y: number }
  readonly #base: readonly string[]
  readonly #additive: boolean
  #ids: string[] = []
  #key = ''

  constructor(ctx: SessionContext, start: PointerPos, p: PointerPos, additive: boolean) {
    super(ctx, start)
    const o = this.point()
    this.#origin = { t: o.t, y: o.y }
    this.#additive = additive
    this.#base = ctx.store.getState().selection.clipIds
    this.last = p
    this.update()
  }

  get ids(): readonly string[] {
    return this.#ids
  }

  protected update(): void {
    const pt = this.point()
    const box = boxFrom(this.#origin.t, this.#origin.y, pt.t, pt.y)
    const hits = clipsInBox(this.ctx.rows, box)
    const ids = this.#additive ? [...new Set([...this.#base, ...hits])] : hits
    const key = ids.join('|')
    if (key === this.#key) return
    this.#key = key
    this.#ids = ids
    this.ctx.store.getState().select(ids)
  }

  render(): void {
    const { view } = this.ctx
    const el = view.els.marquee
    if (!el) return
    const pt = this.point()
    const x0 = view.viewportXOf(Math.min(this.#origin.t, pt.t))
    const x1 = view.viewportXOf(Math.max(this.#origin.t, pt.t))
    const y0 = RULER_HEIGHT + Math.min(this.#origin.y, pt.y) - view.scrollY
    const y1 = RULER_HEIGHT + Math.max(this.#origin.y, pt.y) - view.scrollY
    el.hidden = false
    el.style.transform = `translate3d(${x0}px,${y0}px,0)`
    el.style.width = `${Math.max(1, x1 - x0)}px`
    el.style.height = `${Math.max(1, y1 - y0)}px`
  }

  #hide(): void {
    const el = this.ctx.view.els.marquee
    if (el) el.hidden = true
  }

  commit(): void {
    this.#hide()
  }

  cancel(): void {
    this.#hide()
    this.ctx.store.getState().select(this.#base)
  }
}
