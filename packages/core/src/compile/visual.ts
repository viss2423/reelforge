/**
 * Visual clip pipelines: decode → static "pre" stage (crop, flip, one high-quality scale,
 * HDR tone-map, look) → geometry → output.
 *
 * Performance model (measured on the reference Ryzen 7 8840U at 1080×1920):
 * - every clip is scaled exactly ONCE from its source resolution, straight to the size it
 *   needs at the export resolution (no 1080p intermediate followed by an output scale);
 * - stills are decoded and processed once, then repeated with `loop` (no per-frame scaling);
 * - time is normalised (`fps`) BEFORE any pixel work, so 4× speed never processes the
 *   dropped frames and every downstream filter sees exactly the output frames;
 * - geometry picks the cheapest correct path:
 *     crop         static transform that covers the canvas → a pointer-offset `crop`;
 *     perspective  animated zoom/pan/rotation that always covers the canvas → one
 *                  sub-pixel `perspective` warp (no per-frame scaler re-initialisation);
 *     sprite       anything that leaves canvas visible (contain fit, PiP, opacity, keying)
 *                  → alpha sprite composited with `overlay` (warped only when animated).
 */
import type {
  Adjustments,
  ClipBackground,
  FilterRef,
  MediaClip,
  StickerClip,
  Transform,
} from '../schema.ts'
import type { AnimationPreset } from '../packs.ts'
import { sampledCommands, sendcmdFilter } from './cmd.ts'
import { isHdr, tonemapFilters, displaySize } from './color.ts'
import { applyPixelEffects, effectMotion, resolveEffects, type ResolvedEffect } from './effects.ts'
import { filter } from './escape.ts'
import { num } from './expr.ts'
import { inverseAffinePoint, perspectiveFilter, rotateZoomInverse } from './geometry.ts'
import type { Graph } from './graph.ts'
import type { ClipWindow } from './layout.ts'
import { adjustmentFilters, applyLut, chromaKeyFilter } from './look.ts'
import {
  add,
  constant,
  fromAnimatable,
  fromKeyframes,
  fromPresetTrack,
  mul,
  signalRange,
  type Signal,
} from './signal.ts'
import { sliceSpeedMap, sourceAt, speedMap, videoSpeedFilter } from './speed.ts'
import { hwaccelFor, type CompileAsset, type CompileContext } from './types.ts'

/** Canvas size in canvas px (all transforms are authored in this space). */
export const CANVAS_W = 1080
export const CANVAS_H = 1920

/**
 * Stickers have no meaningful pixel size (SVG, emoji PNGs of any resolution), so at
 * transform scale 1 a sticker fits inside a STICKER_BOX × STICKER_BOX canvas-px square,
 * aspect preserved. The web preview uses the same constant.
 */
export const STICKER_BOX = 540

/** Ken Burns parameters for image `autoMotion` (shared with the web preview). */
export const AUTO_MOTION = {
  /** Zoom reached by zoomIn / started from by zoomOut. */
  ZOOM: 1.15,
  /** Constant zoom during pans (gives the pan room without revealing edges). */
  PAN_ZOOM: 1.12,
} as const

/** Reverse playback buffers frames in memory; chunking bounds that to this much source. */
const REVERSE_CHUNK_US = 2_000_000

/** Shared state of one compilation. */
export interface VideoEnv {
  g: Graph
  ctx: CompileContext
  /** Output (export) size. */
  W: number
  H: number
  /** Export px per canvas px. */
  S: number
  fps: number
  /** swscale flags for the one-time source scale. */
  scaler: string
  /**
   * Subject pass (text behind subject): main clips are rendered as their matte-cut subject
   * over transparency (yuva420p), without pixel effects, so the result can be laid over
   * text drawn on the normal composite.
   */
  subject?: boolean
}

const even = (x: number): number => Math.max(2, Math.round(x / 2) * 2)
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const framesToUs = (frames: number, fps: number): number => (frames * 1e6) / fps

/** Clip-local time expression for a stream whose timestamps start at the window head. */
export const localTime = (headUs: number, t = 't'): string =>
  headUs > 0 ? `(${t}+${num(headUs / 1e6)})` : t

/** `0xRRGGBB` for FFmpeg colour options (alpha of 8-digit hex dropped). */
export const ffColor = (hex: string): string => `0x${hex.slice(1, 7)}`

/* ------------------------------------------------------------------ sources */

/** What a visual clip reads from. */
export interface VisualSource {
  path: string
  kind: 'video' | 'image'
  asset?: CompileAsset
  /** Display (rotation-applied) size in px when known. */
  width?: number
  height?: number
  hdr: boolean
}

/** Resolve the input of a media or sticker clip (undefined → clip is skipped). */
export function resolveSource(
  ctx: CompileContext,
  clip: MediaClip | StickerClip,
): VisualSource | undefined {
  if (clip.type === 'sticker') {
    const asset = clip.assetId ? ctx.assets[clip.assetId] : undefined
    const path = asset?.path ?? (clip.ref ? ctx.resolveSticker(clip.ref) : undefined)
    return path ? { path, kind: 'image', asset, hdr: false } : undefined
  }
  const asset = ctx.assets[clip.assetId]
  if (!asset) return undefined
  const size = displaySize(asset)
  return {
    path: asset.path,
    kind: clip.type === 'image' || asset.kind === 'image' ? 'image' : 'video',
    asset,
    width: size?.width,
    height: size?.height,
    hdr: isHdr(asset),
  }
}

/** Source size after the clip's crop (px; 1080×1920 assumed when not probed). */
function croppedSize(src: VisualSource, clip: MediaClip): { w: number; h: number } {
  const c = clip.crop
  const w = (src.width ?? CANVAS_W) * Math.max(0.01, 1 - c.left - c.right)
  const h = (src.height ?? CANVAS_H) * Math.max(0.01, 1 - c.top - c.bottom)
  return { w, h }
}

/** Scale-1 size of a media clip on the canvas (canvas px) for its `fit`. */
export function fitSize(fit: MediaClip['fit'], w: number, h: number): { w: number; h: number } {
  if (fit === 'fill') return { w: CANVAS_W, h: CANVAS_H }
  const k =
    fit === 'cover' ? Math.max(CANVAS_W / w, CANVAS_H / h) : Math.min(CANVAS_W / w, CANVAS_H / h)
  return { w: w * k, h: h * k }
}

/**
 * Normalised rectangle (0..1) of the clip's cropped and flipped frame — the coordinate space
 * the fit/transform math works in.
 */
export interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}

const FULL: Region = { x0: 0, y0: 0, x1: 1, y1: 1 }

/**
 * One `crop` selecting `region` of the source, folded together with the clip's own crop and
 * expressed in pre-flip source coordinates (flips run after it). Cropping BEFORE the one
 * high-quality scale means only pixels that can reach the canvas are resampled: a 16:9
 * clip cover-fitted to 9:16 scales a 608×1080 window instead of the whole frame (≈3× less
 * work for lanczos and every filter after it).
 */
export function regionCropFilter(clip: MediaClip, region: Region): string | undefined {
  const c = clip.crop
  const cw = Math.max(0.01, 1 - c.left - c.right)
  const ch = Math.max(0.01, 1 - c.top - c.bottom)
  const [rx0, rx1] = clip.transform.flipH ? [1 - region.x1, 1 - region.x0] : [region.x0, region.x1]
  const [ry0, ry1] = clip.transform.flipV ? [1 - region.y1, 1 - region.y0] : [region.y0, region.y1]
  const fx = c.left + rx0 * cw
  const fy = c.top + ry0 * ch
  const fw = (rx1 - rx0) * cw
  const fh = (ry1 - ry0) * ch
  if (fx <= 1e-6 && fy <= 1e-6 && fw >= 1 - 1e-6 && fh >= 1 - 1e-6) return undefined
  return filter('crop', {
    w: `iw*${num(fw)}`,
    h: `ih*${num(fh)}`,
    x: `iw*${num(fx)}`,
    y: `ih*${num(fy)}`,
  })
}

/**
 * Whole-pixel span [offset, offset + size) of a P-px axis covering the fraction [a, b], with
 * an even size (yuv420p) that stays inside the axis when possible.
 */
export function snapSpan(a: number, b: number, P: number): [offset: number, size: number] {
  const limit = Math.max(2, Math.floor(P))
  let o = clamp(Math.floor(a * P), 0, limit - 2)
  let n = Math.min(limit, Math.ceil(b * P)) - o
  if (n % 2 !== 0) {
    if (o + n < limit) n++
    else if (o > 0) {
      o--
      n++
    } else n--
  }
  return [o, Math.max(2, n)]
}

/** Clamp a region to the unit square, padded by `pad` (fractions) on every side. */
function clampRegion(r: Region, padX: number, padY: number): Region {
  return {
    x0: clamp(r.x0 - padX, 0, 1),
    y0: clamp(r.y0 - padY, 0, 1),
    x1: clamp(r.x1 + padX, 0, 1),
    y1: clamp(r.y1 + padY, 0, 1),
  }
}

function flipFilters(t: Transform): string[] {
  const out: string[] = []
  if (t.flipH) out.push('hflip')
  if (t.flipV) out.push('vflip')
  return out
}

/**
 * The one high-quality scale of a source. RGB stills are converted with the BT.709 matrix
 * (matching the output tags); video keeps its matrix (phones tag BT.709 already) and HDR
 * keeps its high bit depth for the tone-mapper.
 */
function scaleFilter(env: VideoEnv, src: VisualSource, w: number, h: number): string {
  return filter('scale', {
    w,
    h,
    flags: env.scaler,
    out_color_matrix: src.kind === 'image' ? 'bt709' : undefined,
    out_range: src.kind === 'image' ? 'tv' : undefined,
  })
}

/** Static look of a clip (adjustments + LUT) applied to `label`. */
function applyLook(
  env: VideoEnv,
  label: string,
  look: { adjustments?: Adjustments; filter?: FilterRef },
): string {
  let cur = label
  if (look.adjustments) cur = env.g.chain(cur, adjustmentFilters(look.adjustments, env.S))
  if (look.filter) cur = applyLut(env.g, cur, look.filter, env.ctx)
  return cur
}

/* ------------------------------------------------------------------ decode */

/** Source range (absolute source us) a video clip window reads, plus the sliced speed map. */
export function sourceWindow(
  clip: Pick<MediaClip, 'in' | 'duration' | 'speed' | 'speedRamp' | 'reverse'>,
  headUs: number,
  lenUs: number,
): { start: number; span: number; map: ReturnType<typeof speedMap> } {
  const full = speedMap(clip)
  const map = sliceSpeedMap(full, headUs, headUs + lenUs)
  const u0 = sourceAt(full, headUs)
  const start = clip.reverse
    ? clip.in + Math.max(0, full.sourceSpan - u0 - map.sourceSpan)
    : clip.in + u0
  return { start: Math.round(start), span: map.sourceSpan, map }
}

/** Extra source read past the window so `fps`/`tpad` always have a closing frame. */
export const SOURCE_MARGIN_US = 100_000

/**
 * Decode a clip window into exactly `win.frames` CFR frames with timestamps starting at 0
 * (= clip-local time `head`). `pre` is the static per-pixel stage; it runs after time
 * normalisation for forward video, per chunk before `reverse` for reversed video (so the
 * reverse buffer holds small, already-scaled frames) and once before `loop` for stills.
 */
export function decode(
  env: VideoEnv,
  clip: MediaClip | StickerClip,
  src: VisualSource,
  win: ClipWindow,
  pre: (label: string) => string,
): string {
  const { g, fps } = env
  const exact = [`tpad=stop_mode=clone:stop=${win.frames}`, `trim=end_frame=${win.frames}`]
  if (src.kind === 'image' || clip.type === 'sticker') {
    const i = g.input({ path: src.path })
    // Timestamps are rebuilt in a 1/fps time base: `N/(fps*TB)` in the image demuxer's
    // 1/25 base rounds two frames onto one pts and `fps` would drop one.
    return g.chain(pre(`${i}:v`), [
      `settb=1/${fps}`,
      win.frames > 1 ? `loop=loop=${win.frames - 1}:size=1:start=0` : undefined,
      'setpts=N',
      `fps=${fps}`,
      `trim=end_frame=${win.frames}`,
    ])
  }
  const headUs = framesToUs(win.head, fps)
  const lenUs = framesToUs(win.frames, fps)
  const sw = sourceWindow(clip, headUs, lenUs)
  const speed = videoSpeedFilter(sw.map) ?? 'setpts=PTS-STARTPTS'
  const hwaccel = hwaccelFor(env.ctx, src.asset)
  if (!clip.reverse) {
    const i = g.input({
      path: src.path,
      seek: sw.start,
      duration: sw.span + SOURCE_MARGIN_US,
      hwaccel,
    })
    return pre(g.chain(`${i}:v`, [speed, `fps=${fps}`, ...exact]))
  }
  // Reverse in bounded chunks: chunk k covers reversed-stream offsets [k·C, (k+1)·C), i.e.
  // source [end − (k+1)·C, end − k·C), each reversed on its own and concatenated in order.
  const chunks: string[] = []
  const end = sw.start + sw.span
  for (let off = 0; off < sw.span; off += REVERSE_CHUNK_US) {
    const len = Math.min(REVERSE_CHUNK_US, sw.span - off)
    const i = g.input({ path: src.path, seek: end - off - len, duration: len, hwaccel })
    chunks.push(g.chain(pre(g.chain(`${i}:v`, ['setpts=PTS-STARTPTS'])), ['reverse']))
  }
  const joined =
    chunks.length === 1 ? chunks[0]! : g.add(chunks, [`concat=n=${chunks.length}:v=1:a=0`])[0]!
  return g.chain(joined, [speed, `fps=${fps}`, ...exact])
}

/* ------------------------------------------------------------------ motion */

/** Animated placement of a clip in canvas px; rotation in radians. */
export interface ClipMotion {
  cx: Signal
  cy: Signal
  z: Signal
  rot: Signal
  opacity: Signal
}

/** Ken Burns motion of an image over its duration. */
export function autoMotion(
  kind: MediaClip['autoMotion'],
  durationUs: number,
  baseW: number,
): { dx: Signal; zoom: Signal } {
  const lin = (a: number, b: number): Signal =>
    fromKeyframes(
      [
        { t: 0, value: a, easing: 'linear' },
        { t: durationUs, value: b, easing: 'linear' },
      ],
      a,
    )
  switch (kind) {
    case 'zoomIn':
      return { dx: constant(0), zoom: lin(1, AUTO_MOTION.ZOOM) }
    case 'zoomOut':
      return { dx: constant(0), zoom: lin(AUTO_MOTION.ZOOM, 1) }
    case 'panLeft':
    case 'panRight': {
      // Travel the full slack the pan zoom creates on a cover-fitted frame.
      const slack = Math.max(0, (baseW * AUTO_MOTION.PAN_ZOOM - CANVAS_W) / 2)
      const s = kind === 'panLeft' ? 1 : -1
      return { dx: lin(s * slack, -s * slack), zoom: constant(AUTO_MOTION.PAN_ZOOM) }
    }
    case 'none':
      return { dx: constant(0), zoom: constant(1) }
  }
}

/** Sticker/text-style in/out animation contributions (pack AnimationPreset tracks). */
function presetMotion(presets: { preset: AnimationPreset; start: number; duration: number }[]): {
  dx: Signal
  dy: Signal
  zoom: Signal
  rot: Signal
  opacity: Signal
} {
  const dx: Signal[] = []
  const dy: Signal[] = []
  const zoom: Signal[] = []
  const rot: Signal[] = []
  const opacity: Signal[] = []
  for (const { preset, start, duration } of presets) {
    const tr = preset.tracks
    dx.push(fromPresetTrack(tr.x, 0, start, duration))
    dy.push(fromPresetTrack(tr.y, 0, start, duration))
    zoom.push(fromPresetTrack(tr.scale, 1, start, duration))
    rot.push(fromPresetTrack(tr.rotation, 0, start, duration))
    opacity.push(fromPresetTrack(tr.opacity, 1, start, duration))
  }
  return {
    dx: add(...dx),
    dy: add(...dy),
    zoom: mul(...zoom),
    rot: add(...rot),
    opacity: mul(...opacity),
  }
}

/** Combined motion of a clip: transform keyframes + motion effects + auto motion + presets. */
export function clipMotion(
  clip: MediaClip | StickerClip,
  effects: readonly ResolvedEffect[],
  baseW: number,
  anim: Pick<CompileContext, 'resolveAnimation'>,
): ClipMotion {
  const t = clip.transform
  const fx = effectMotion(effects)
  const auto = clip.type === 'image' ? autoMotion(clip.autoMotion, clip.duration, baseW) : undefined
  const presets: { preset: AnimationPreset; start: number; duration: number }[] = []
  if (clip.type === 'sticker' && anim.resolveAnimation) {
    const inP = clip.animationIn && anim.resolveAnimation(clip.animationIn.ref)
    if (inP && clip.animationIn) {
      presets.push({
        preset: inP,
        start: 0,
        duration: Math.min(clip.animationIn.duration, clip.duration),
      })
    }
    const outP = clip.animationOut && anim.resolveAnimation(clip.animationOut.ref)
    if (outP && clip.animationOut) {
      const d = Math.min(clip.animationOut.duration, clip.duration)
      presets.push({ preset: outP, start: clip.duration - d, duration: d })
    }
  }
  const pm = presets.length > 0 ? presetMotion(presets) : undefined
  const DEG = Math.PI / 180
  return {
    cx: add(fromAnimatable(t.x), fx.dx, auto?.dx ?? constant(0), pm?.dx ?? constant(0)),
    cy: add(fromAnimatable(t.y), fx.dy, pm?.dy ?? constant(0)),
    z: mul(fromAnimatable(t.scale), fx.zoom, auto?.zoom ?? constant(1), pm?.zoom ?? constant(1)),
    rot: pm
      ? add(fromAnimatable(t.rotation, DEG), mul(pm.rot, constant(DEG)))
      : fromAnimatable(t.rotation, DEG),
    opacity: pm ? mul(fromAnimatable(t.opacity), pm.opacity) : fromAnimatable(t.opacity),
  }
}

/** Clip-local sample times (us) of every frame in the window (capped for long clips). */
function sampleTimes(win: ClipWindow, fps: number): number[] {
  const n = win.frames
  const stride = Math.max(1, Math.floor(n / 600))
  const out: number[] = []
  for (let k = 0; k < n; k += stride) out.push(framesToUs(win.head + k, fps))
  out.push(framesToUs(win.head + n - 1, fps))
  return out
}

/**
 * True when the transformed clip (base size bw×bh canvas px) covers the whole canvas in
 * every frame of the window, i.e. every canvas corner maps inside the clip.
 */
export function coversCanvas(
  m: ClipMotion,
  bw: number,
  bh: number,
  win: ClipWindow,
  fps: number,
): boolean {
  const corners = [
    [0, 0],
    [CANVAS_W, 0],
    [0, CANVAS_H],
    [CANVAS_W, CANVAS_H],
  ] as const
  for (const us of sampleTimes(win, fps)) {
    const cx = m.cx.at(us)
    const cy = m.cy.at(us)
    const z = m.z.at(us)
    const th = m.rot.at(us)
    const c = Math.cos(th)
    const s = Math.sin(th)
    const hw = (bw * z) / 2 + 0.01
    const hh = (bh * z) / 2 + 0.01
    for (const [u, v] of corners) {
      const dx = u - cx
      const dy = v - cy
      if (Math.abs(dx * c + dy * s) > hw || Math.abs(dy * c - dx * s) > hh) return false
    }
  }
  return true
}

const isStatic = (s: Signal): boolean => s.constant !== undefined

/** Range of a signal over the window. */
function windowRange(s: Signal, win: ClipWindow, fps: number): { min: number; max: number } {
  if (s.constant !== undefined) return { min: s.constant, max: s.constant }
  let min = Infinity
  let max = -Infinity
  for (const us of sampleTimes(win, fps)) {
    const v = s.at(us)
    if (v < min) min = v
    if (v > max) max = v
  }
  // Include easing overshoot between frames.
  const r = signalRange(s, framesToUs(win.head + win.frames, fps), fps)
  return { min: Math.min(min, r.min), max: Math.max(max, r.max) }
}

/* ------------------------------------------------------------------ sprites */

/** A sprite stream ready for `overlay`, with its centre position in export px. */
export interface Sprite {
  label: string
  /** Overlay x/y expressions (top-left), using `t` = the overlay's time variable. */
  x: (t: string) => string
  y: (t: string) => string
  /** True when x/y change over time (overlay needs eval=frame). */
  animated: boolean
}

/** Input description shared by main-track and overlay sprites. */
export interface SpriteInput {
  clip: MediaClip | StickerClip
  src: VisualSource
  win: ClipWindow
  /** Scale-1 size on the canvas (canvas px). */
  base: { w: number; h: number }
  motion: ClipMotion
  /** Effects applied to the sprite pixels (overlay clips); empty for main clips. */
  effects: readonly ResolvedEffect[]
  /** Split off a copy of the decoded frames for a blurred background fill. */
  wantFill: boolean
  /** Keep still-image transparency (overlay tracks). */
  keepAlpha: boolean
}

/** Pre stage for a sticker: fit into the sticker box and pad to an exact square. */
function stickerPre(env: VideoEnv, px: number): (l: string) => string {
  return (l) =>
    env.g.chain(l, [
      filter('scale', {
        w: px,
        h: px,
        force_original_aspect_ratio: 'decrease',
        flags: env.scaler,
        out_color_matrix: 'bt709',
        out_range: 'tv',
      }),
      'format=yuva420p',
      `pad=${px}:${px}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    ])
}

/* ------------------------------------------------------------------ AI background (matte) */

/** Background σ in canvas px per unit of `ClipBackground.blur` (shared with the preview). */
export const BACKGROUND_BLUR_SIGMA = 0.4
/** Matte feather σ in canvas px per unit of `ClipBackground.feather` (shared with the preview). */
export const MATTE_FEATHER_SIGMA = 0.08

/** The clip's AI background and matte file, when it applies (mode ≠ keep, matte ready). */
export function activeBackground(
  ctx: CompileContext,
  clip: MediaClip | StickerClip,
  forceRemove = false,
): { bg: ClipBackground; matte: string } | undefined {
  if (clip.type === 'sticker') return undefined
  const bg = clip.background
  if (!forceRemove && (!bg || bg.mode === 'keep')) return undefined
  if (!forceRemove && bg?.mode === 'image' && !(bg.assetId && ctx.assets[bg.assetId]))
    return undefined
  const matte = ctx.resolveMatte?.(clip.assetId)
  if (!matte) return undefined
  const base: ClipBackground = bg ?? {
    mode: 'remove',
    color: '#000000',
    blur: 50,
    feather: 0,
  }
  return { bg: forceRemove ? { ...base, mode: 'remove' } : base, matte }
}

/** Matte pre stage: exactly the clip's crop/flip/scale, as 8-bit gray (full range). */
function maskPre(
  env: VideoEnv,
  clip: MediaClip,
  size: { w: number; h: number; region?: Region },
  feather: number,
): (l: string) => string {
  const sigma = feather * MATTE_FEATHER_SIGMA * env.S
  return (l) =>
    env.g.chain(l, [
      'format=gray',
      regionCropFilter(clip, size.region ?? FULL),
      ...flipFilters(clip.transform),
      filter('scale', { w: size.w, h: size.h, flags: 'bilinear' }),
      sigma >= 0.3 ? filter('gblur', { sigma: num(sigma, 3) }) : undefined,
    ])
}

/**
 * A still image cover-fitted to the clip's whole frame, of which `region` (w×h px) is kept,
 * for exactly `frames` frames (pts from 0). Covering the whole frame (not just the region a
 * crop path decodes) keeps the framing identical to the preview's per-layer cover fit.
 */
function imageLayer(
  env: VideoEnv,
  path: string,
  size: { w: number; h: number; region?: Region },
  frames: number,
): string {
  const { g, fps } = env
  const r = size.region ?? FULL
  const fw = even(size.w / Math.max(1e-6, r.x1 - r.x0))
  const fh = even(size.h / Math.max(1e-6, r.y1 - r.y0))
  const x = clamp(Math.round(r.x0 * fw), 0, Math.max(0, fw - size.w))
  const y = clamp(Math.round(r.y0 * fh), 0, Math.max(0, fh - size.h))
  const i = g.input({ path })
  return g.chain(`${i}:v`, [
    filter('scale', {
      w: fw,
      h: fh,
      force_original_aspect_ratio: 'increase',
      flags: env.scaler,
      out_color_matrix: 'bt709',
      out_range: 'tv',
    }),
    `crop=${fw}:${fh}`,
    fw === size.w && fh === size.h ? undefined : `crop=${size.w}:${size.h}:${x}:${y}`,
    'format=yuv420p',
    `settb=1/${fps}`,
    frames > 1 ? `loop=loop=${frames - 1}:size=1:start=0` : undefined,
    'setpts=N',
    `fps=${fps}`,
    `trim=end_frame=${frames}`,
  ])
}

/**
 * Decode a media clip window through its pre stage and, when it has an active AI
 * background, composite it in the clip's own frame space (before geometry): the matte is
 * decoded with the same timing, crop, flips and size, then
 * - remove → `alphamerge` (yuva420p: the caller must composite it as a sprite)
 * - blur / color / image → the subject (alpha = matte) `overlay`ed on that background.
 */
function decodeMedia(
  env: VideoEnv,
  clip: MediaClip,
  src: VisualSource,
  win: ClipWindow,
  size: { w: number; h: number; alpha?: boolean; region?: Region },
): string {
  const { g } = env
  const fg = decode(env, clip, src, win, mediaPre(env, clip, src, size))
  const active = activeBackground(env.ctx, clip, env.subject)
  if (!active) return fg
  const { bg, matte } = active
  const mask = decode(
    env,
    clip,
    { path: matte, kind: src.kind, hdr: false },
    win,
    maskPre(env, clip, size, bg.feather),
  )
  if (bg.mode === 'remove') return g.add([fg, mask], ['alphamerge'])[0]!
  let back: string
  let subject: string
  if (bg.mode === 'blur') {
    const [a, b] = g.pair(fg)
    const sigma = bg.blur * BACKGROUND_BLUR_SIGMA * env.S
    back = sigma >= 0.3 ? g.chain(a, [filter('gblur', { sigma: num(sigma, 3) })]) : a
    subject = b
  } else {
    back =
      bg.mode === 'image'
        ? imageLayer(env, env.ctx.assets[bg.assetId!]!.path, size, win.frames)
        : g.source([
            filter('color', { c: ffColor(bg.color), s: `${size.w}x${size.h}`, r: env.fps }),
            'format=yuv420p',
            `trim=end_frame=${win.frames}`,
          ])
    subject = fg
  }
  const cut = g.add([subject, mask], ['alphamerge'])[0]!
  return g.add(
    [back, cut],
    [filter('overlay', { format: 'yuv420', shortest: 1 }), 'format=yuv420p'],
  )[0]!
}

/**
 * Static pre stage for a media clip: `region` of the (cropped, flipped) frame scaled to
 * w×h export px. `alpha` keeps transparency of stills (logos on overlay tracks); main-track
 * media is always opaque.
 */
function mediaPre(
  env: VideoEnv,
  clip: MediaClip,
  src: VisualSource,
  size: { w: number; h: number; alpha?: boolean; region?: Region },
): (l: string) => string {
  // Crop-then-scale: only pixels that can reach the canvas are resampled. `crop` snaps to
  // whole (even) source px, so framing is exact to within one source pixel.
  const geometry = [
    regionCropFilter(clip, size.region ?? FULL),
    ...flipFilters(clip.transform),
    scaleFilter(env, src, size.w, size.h),
  ]
  return (l) => {
    const scaled = env.g.chain(l, [
      ...geometry,
      ...(src.hdr && src.asset ? tonemapFilters(src.asset) : []),
      src.hdr
        ? undefined
        : size.alpha && src.kind === 'image'
          ? 'format=yuva420p'
          : 'format=yuv420p',
    ])
    return applyLook(env, scaled, { adjustments: clip.adjustments, filter: clip.filter })
  }
}

/** Opacity (static or animated) applied to a yuva stream via the alpha LUT. */
function applyOpacity(env: VideoEnv, label: string, opacity: Signal, win: ClipWindow): string {
  if (opacity.constant !== undefined) {
    if (opacity.constant >= 0.999) return label
    return env.g.chain(label, [
      filter('lut', { a: `val*${num(clamp(opacity.constant, 0, 1), 4)}` }),
    ])
  }
  const headUs = framesToUs(win.head, env.fps)
  const id = `lut@${env.g.label('op')}`
  const cmds = sampledCommands({
    target: id,
    command: 'a',
    signal: { constant: undefined, expr: () => '1', at: (us) => clamp(opacity.at(us), 0, 1) },
    fromUs: headUs,
    toUs: headUs + framesToUs(win.frames, env.fps),
    fps: env.fps,
    offsetUs: -headUs,
    format: (v) => `val*${num(v, 3)}`,
  })
  const first = clamp(opacity.at(headUs), 0, 1)
  return env.g.chain(label, [sendcmdFilter(cmds), filter(id, { a: `val*${num(first, 3)}` })])
}

/**
 * Build a sprite: decoded, looked, keyed, warped (only when scale/rotation animate),
 * opacity applied. Returns the sprite and (optionally) a fill copy of the decoded frames.
 */
export function buildSprite(env: VideoEnv, s: SpriteInput): { sprite: Sprite; fill?: string } {
  const { g, S, fps } = env
  const { clip, motion: m, win } = s
  const headUs = framesToUs(win.head, fps)
  const zr = windowRange(m.z, win, fps)
  const zStatic = isStatic(m.z)
  const rotStatic = isStatic(m.rot)
  // Prescale factor: the static zoom, or the largest animated zoom (capped: beyond 2× the
  // warp upsamples, which costs area without adding detail).
  const q = zStatic ? Math.max(0.01, zr.max) : clamp(zr.max, 0.05, 2)
  const PW = even(s.base.w * q * S)
  const PH = even(s.base.h * q * S)
  let label: string
  if (clip.type === 'sticker') {
    label = decode(env, clip, s.src, win, stickerPre(env, PW))
  } else {
    label = decodeMedia(env, clip, s.src, win, { w: PW, h: PH, alpha: s.keepAlpha })
  }
  let fill: string | undefined
  if (s.wantFill) [label, fill] = g.pair(label)
  if (s.effects.length > 0) {
    label = applyPixelEffects(g, label, shiftEffects(s.effects, headUs), {
      fps,
      scale: S,
      size: { w: PW, h: PH },
    })
  }
  const key = clip.type === 'sticker' ? undefined : chromaKeyFilter(clip.chromaKey)
  if (key) label = g.chain(label, [key])
  // Warps, rotation and opacity need an alpha plane (chromakey already produces one).
  const needsAlpha = !rotStatic || !zStatic || m.rot.constant !== 0 || m.opacity.constant !== 1
  if (needsAlpha && !key && clip.type !== 'sticker') label = g.chain(label, ['format=yuva420p'])
  const T = localTime(headUs, `(in/${fps})`)
  if (!zStatic || !rotStatic) {
    // Fixed-size bounding box; the sprite is padded with transparency so the warp's edge
    // clamping samples transparent pixels outside the sprite.
    const grow = zr.max / q
    const rotating = !rotStatic || m.rot.constant !== 0
    const bw = rotating ? Math.hypot(PW, PH) * grow : PW * grow
    const bh = rotating ? Math.hypot(PW, PH) * grow : PH * grow
    const BW = even(Math.max(bw, PW) + 4)
    const BH = even(Math.max(bh, PH) + 4)
    label = g.chain(label, [
      `pad=${BW}:${BH}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      perspectiveFilter(
        BW,
        BH,
        rotateZoomInverse({
          ocx: num(BW / 2),
          ocy: num(BH / 2),
          scx: num(BW / 2),
          scy: num(BH / 2),
          z: zStatic ? num(zr.max / q) : `(${m.z.expr(T)}/${num(q)})`,
          theta: rotating ? (rotStatic ? num(m.rot.constant!) : m.rot.expr(T)) : undefined,
        }),
      ),
    ])
  } else if (m.rot.constant !== 0) {
    const a = num(m.rot.constant!)
    label = g.chain(label, [
      filter('rotate', { a, ow: `rotw(${a})`, oh: `roth(${a})`, c: 'none', bilinear: 1 }),
    ])
  }
  label = applyOpacity(env, label, m.opacity, win)
  const animated = !isStatic(m.cx) || !isStatic(m.cy)
  const sprite: Sprite = {
    label,
    animated,
    x: (t) => `${m.cx.expr(t)}*${num(S)}-overlay_w/2`,
    y: (t) => `${m.cy.expr(t)}*${num(S)}-overlay_h/2`,
  }
  return { sprite, fill }
}

/** Shift effect windows into stream time (clip-local minus the window head). */
export function shiftEffects(effects: readonly ResolvedEffect[], headUs: number): ResolvedEffect[] {
  if (headUs <= 0) return [...effects]
  return effects
    .map((e) => ({ ...e, start: e.start - headUs, end: e.end - headUs }))
    .filter((e) => e.end > 0)
}

/* ------------------------------------------------------------------ main-track clip */

/** Background behind a main clip that does not cover the canvas. */
function background(
  env: VideoEnv,
  fill: string | undefined,
  frames: number,
  color: string,
): string {
  const { g, W, H, fps } = env
  if (fill) {
    // Blurred cover-fill computed at ¼ resolution (16× fewer pixels; a heavy blur hides it).
    const w = even(W / 4)
    const h = even(H / 4)
    return g.chain(fill, [
      filter('scale', { w, h, force_original_aspect_ratio: 'increase', flags: 'fast_bilinear' }),
      `crop=${w}:${h}`,
      'boxblur=luma_radius=12:luma_power=2:chroma_radius=6:chroma_power=2',
      'format=yuv420p',
      filter('scale', { w: W, h: H, flags: 'bilinear' }),
    ])
  }
  return g.source([
    filter('color', { c: ffColor(color), s: `${W}x${H}`, r: fps }),
    'format=yuv420p',
    `trim=end_frame=${frames}`,
  ])
}

/**
 * The part of a prescaled frame (PW×PH export px, normalised 0..1) that a covering warp
 * samples in any frame of the window: the inverse-mapped canvas corners, unioned over every
 * frame, padded by 2 px for bilinear taps and sub-frame easing.
 */
export function warpReach(
  m: ClipMotion,
  win: ClipWindow,
  fps: number,
  o: { W: number; H: number; S: number; PW: number; PH: number; q: number },
): Region {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const corners = [
    [0, 0],
    [o.W, 0],
    [0, o.H],
    [o.W, o.H],
  ] as const
  for (let k = 0; k < win.frames; k++) {
    const us = framesToUs(win.head + k, fps)
    const placement = {
      ocx: m.cx.at(us) * o.S,
      ocy: m.cy.at(us) * o.S,
      scx: o.PW / 2,
      scy: o.PH / 2,
      z: m.z.at(us) / o.q,
      theta: m.rot.at(us),
    }
    for (const [u, v] of corners) {
      const p = inverseAffinePoint(u, v, placement)
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
  }
  return clampRegion(
    { x0: x0 / o.PW, y0: y0 / o.PH, x1: x1 / o.PW, y1: y1 / o.PH },
    2 / o.PW,
    2 / o.PH,
  )
}

/** Render a main-track clip window to exactly `win.frames` W×H yuv420p frames (pts from 0). */
export function renderMainClip(
  env: VideoEnv,
  clip: MediaClip,
  win: ClipWindow,
  project: { background: string; backgroundBlur: boolean },
): string | undefined {
  const { g, W, H, S, fps, ctx } = env
  const src = resolveSource(ctx, clip)
  if (!src) return undefined
  const headUs = framesToUs(win.head, fps)
  const effects = resolveEffects(clip.effects, clip.duration, (r) => ctx.resolveEffect(r))
  const cs = croppedSize(src, clip)
  const base = fitSize(clip.fit, cs.w, cs.h)
  const m = clipMotion(clip, effects, base.w, ctx)
  const cutout = activeBackground(ctx, clip, env.subject)
  if (env.subject && !cutout) return transparent(env, win.frames)
  const opaque =
    m.opacity.constant !== undefined &&
    m.opacity.constant >= 0.999 &&
    !clip.chromaKey?.enabled &&
    cutout?.bg.mode !== 'remove'
  const covers = opaque && coversCanvas(m, base.w, base.h, win, fps)
  let label: string
  if (covers && isStatic(m.cx) && isStatic(m.cy) && isStatic(m.z) && m.rot.constant === 0) {
    // crop path: only the canvas window of the zoomed frame is cropped out of the source and
    // scaled straight to W×H.
    const z = m.z.constant!
    const zw = base.w * z
    const zh = base.h * z
    const x0 = clamp(zw / 2 - m.cx.constant!, 0, Math.max(0, zw - CANVAS_W))
    const y0 = clamp(zh / 2 - m.cy.constant!, 0, Math.max(0, zh - CANVAS_H))
    const region = {
      x0: x0 / zw,
      y0: y0 / zh,
      x1: Math.min(1, (x0 + CANVAS_W) / zw),
      y1: Math.min(1, (y0 + CANVAS_H) / zh),
    }
    label = decodeMedia(env, clip, src, win, { w: W, h: H, region })
  } else if (covers) {
    // perspective path: prescale to the largest zoom (so zoomed frames keep detail), but
    // never beyond the source's own resolution (that adds area, not detail) nor 1.5×; the
    // frame must still cover the output. Only the source window the warp ever samples
    // (union over all frames) is cropped, scaled and warped.
    const zr = windowRange(m.z, win, fps)
    const detail = Math.min(zr.max, 1.5, cs.w / (base.w * S))
    const q = Math.max(detail, W / (base.w * S), H / (base.h * S))
    const PW = base.w * q * S
    const PH = base.h * q * S
    const reach = warpReach(m, win, fps, { W, H, S, PW, PH, q })
    const [ox, BW] = snapSpan(reach.x0, reach.x1, PW)
    const [oy, BH] = snapSpan(reach.y0, reach.y1, PH)
    // the crop selects exactly the whole-pixel window that is then scaled 1:1 to BW×BH, so
    // the warp's centre offset (ox, oy) is exact.
    const region = { x0: ox / PW, y0: oy / PH, x1: (ox + BW) / PW, y1: (oy + BH) / PH }
    const decoded = decodeMedia(env, clip, src, win, { w: BW, h: BH, region })
    // perspective's output is its input size: pad up to the canvas if the window is smaller.
    const FW = Math.max(W, BW)
    const FH = Math.max(H, BH)
    const T = localTime(headUs, `(in/${fps})`)
    const rotating = !isStatic(m.rot) || m.rot.constant !== 0
    label = g.chain(decoded, [
      FW > BW || FH > BH ? `pad=${FW}:${FH}:0:0` : undefined,
      perspectiveFilter(
        FW,
        FH,
        rotateZoomInverse({
          ocx: `(${m.cx.expr(T)}*${num(S)})`,
          ocy: `(${m.cy.expr(T)}*${num(S)})`,
          scx: num(PW / 2 - ox),
          scy: num(PH / 2 - oy),
          z: `(${m.z.expr(T)}/${num(q)})`,
          theta: rotating ? m.rot.expr(T) : undefined,
        }),
        { interpolation: 'linear' },
      ),
      FW === W && FH === H ? undefined : `crop=${W}:${H}:0:0`,
    ])
  } else {
    const { sprite, fill } = buildSprite(env, {
      clip,
      src,
      win,
      base,
      motion: m,
      effects: [],
      wantFill: project.backgroundBlur && !env.subject,
      keepAlpha: false,
    })
    const bg = env.subject
      ? transparent(env, win.frames)
      : background(env, fill, win.frames, project.background)
    const T = localTime(headUs)
    label = g.add(
      [bg, sprite.label],
      [
        filter('overlay', {
          x: sprite.x(T),
          y: sprite.y(T),
          eval: sprite.animated ? 'frame' : 'init',
          format: 'yuv420',
        }),
      ],
    )[0]!
  }
  if (env.subject) return g.chain(label, ['setsar=1', 'format=yuva420p'])
  label = applyPixelEffects(g, label, shiftEffects(effects, headUs), {
    fps,
    scale: S,
    size: { w: W, h: H },
  })
  return g.chain(label, ['setsar=1', 'format=yuv420p'])
}

/** Fully transparent canvas frames (subject pass). */
export function transparent(env: VideoEnv, frames: number): string {
  return env.g.source([
    filter('color', { c: 'black@0', s: `${env.W}x${env.H}`, r: env.fps }),
    'format=yuva420p',
    `trim=end_frame=${frames}`,
  ])
}

/* ------------------------------------------------------------------ overlay-track clip */

/** Composite an overlay-track clip (video/image/sticker) onto `comp`. */
export function renderOverlayClip(
  env: VideoEnv,
  comp: string,
  clip: MediaClip | StickerClip,
  win: ClipWindow,
  windowStart: number,
  compFrames: number,
): string {
  const { g, fps, ctx } = env
  const src = resolveSource(ctx, clip)
  if (!src) return comp
  const effects =
    clip.type === 'sticker'
      ? []
      : resolveEffects(clip.effects, clip.duration, (r) => ctx.resolveEffect(r))
  const base =
    clip.type === 'sticker'
      ? { w: STICKER_BOX, h: STICKER_BOX }
      : (() => {
          const cs = croppedSize(src, clip)
          return fitSize(clip.fit, cs.w, cs.h)
        })()
  const m = clipMotion(clip, effects, base.w, ctx)
  const { sprite } = buildSprite(env, {
    clip,
    src,
    win,
    base,
    motion: m,
    effects,
    wantFill: false,
    keepAlpha: true,
  })
  const headUs = framesToUs(win.head, fps)
  const a = win.start - windowStart
  const b = a + win.frames
  const mode = clip.type === 'sticker' ? 'normal' : clip.blendMode
  if (mode === 'normal') {
    const off = a / fps
    const placed = g.chain(sprite.label, [off > 0 ? `setpts=PTS+${num(off)}/TB` : undefined])
    // overlay's t is comp time; clip-local = t − off + head.
    const T = `(t-${num(off)}+${num(headUs / 1e6)})`
    return g.add(
      [comp, placed],
      [
        filter('overlay', {
          x: sprite.x(T),
          y: sprite.y(T),
          eval: sprite.animated ? 'frame' : 'init',
          format: 'yuv420',
          eof_action: 'pass',
          repeatlast: 0,
          enable: `between(n,${a},${b - 1})`,
        }),
      ],
    )[0]!
  }
  return blendWindow(env, comp, sprite, mode, { a, b, compFrames, headUs })
}

const BLEND_MODES = {
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
  lighten: 'lighten',
  darken: 'darken',
  add: 'addition',
} as const

/**
 * Non-normal blend mode over comp frames [a, b): only that window is cut out (split + trim,
 * no pixel cost elsewhere), blended in RGB with the sprite's alpha as the mask, and
 * concatenated back.
 */
function blendWindow(
  env: VideoEnv,
  comp: string,
  sprite: Sprite,
  mode: keyof typeof BLEND_MODES,
  w: { a: number; b: number; compFrames: number; headUs: number },
): string {
  const { g, W, H, fps } = env
  const parts: string[] = []
  const needPre = w.a > 0
  const needPost = w.b < w.compFrames
  const [preL, midL, postL] = (() => {
    const n = 1 + (needPre ? 1 : 0) + (needPost ? 1 : 0)
    const ls = g.split(comp, n)
    let i = 0
    return [needPre ? ls[i++] : undefined, ls[i++]!, needPost ? ls[i++] : undefined]
  })()
  if (preL) parts.push(g.chain(preL, [`trim=end_frame=${w.a}`]))
  const mid = g.chain(midL, [`trim=start_frame=${w.a}:end_frame=${w.b}`, 'setpts=PTS-STARTPTS'])
  const [m1, m2] = g.pair(mid)
  const canvas = g.source([
    filter('color', { c: 'black@0', s: `${W}x${H}`, r: fps }),
    'format=yuva420p',
    `trim=end_frame=${w.b - w.a}`,
  ])
  const T = localTime(w.headUs)
  const placed = g.add(
    [canvas, sprite.label],
    [
      filter('overlay', {
        x: sprite.x(T),
        y: sprite.y(T),
        eval: sprite.animated ? 'frame' : 'init',
        format: 'yuv420',
      }),
    ],
  )[0]!
  const [sc1, sc2] = g.pair(placed)
  const top = g.chain(sc1, ['format=gbrp'])
  const bottom = g.chain(m1, ['format=gbrp'])
  const blended = g.add(
    [bottom, top],
    [filter('blend', { all_mode: BLEND_MODES[mode] }), 'format=yuv420p'],
  )[0]!
  const mask = g.chain(sc2, ['alphaextract'])
  const withAlpha = g.add([blended, mask], ['alphamerge'])[0]!
  parts.push(g.add([m2, withAlpha], [filter('overlay', { format: 'yuv420' })])[0]!)
  if (postL) parts.push(g.chain(postL, [`trim=start_frame=${w.b}`, 'setpts=PTS-STARTPTS']))
  if (parts.length === 1) return parts[0]!
  return g.add(parts, [`concat=n=${parts.length}:v=1:a=0`])[0]!
}
