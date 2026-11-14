/**
 * Layer geometry: turns a visual clip at a clip-local time into the numbers the compositor
 * needs — an affine matrix from a unit quad to clip space, the source UV rectangle (crop),
 * opacity, and effect outputs. Pure and allocation-free (writes into a reusable
 * {@link LayerState}).
 *
 * Conventions (shared with the export compiler):
 * - Canvas is 1080×1920 px, origin top-left, y down. `transform.x/y` is the clip's centre.
 * - `fit` sizes the CROPPED source to the canvas: cover = fill canvas (overflow cropped),
 *   contain = letterbox, fill = stretch to 1080×1920. `transform.scale` multiplies that.
 * - Rotation is clockwise degrees about the centre; flips mirror the content in place.
 * - Crop is normalised to the DISPLAYED (rotation-corrected) source frame.
 * - Image auto motion (Ken Burns) is linear over the clip: zoom 1→1.15 (or back), or a
 *   pan at 1.15× that travels the full overflow so cover-fitted images never show borders.
 * - Stickers are drawn at their natural pixel size (contain-fitted if larger than the canvas).
 */
import {
  evaluate,
  evaluatePreset,
  type AnimationPreset,
  type EffectPreset,
  type MediaClip,
  type StickerClip,
  type TextAnimation,
} from '@reelforge/core'
import {
  createEffectState,
  evaluateEffects,
  resetEffectState,
  type EffectState,
} from '../effects/effects.ts'

export const CANVAS_W = 1080
export const CANVAS_H = 1920

/** Ken Burns zoom factor for image auto motion. */
export const AUTO_MOTION_ZOOM = 1.15

export type Rotation = 0 | 90 | 180 | 270

/** Intrinsic source description (texture size as stored, plus display rotation). */
export interface SourceInfo {
  width: number
  height: number
  /** Clockwise rotation to apply for display (container metadata). */
  rotation: Rotation
}

export interface LayerState {
  /**
   * Affine map from the unit quad (qx, qy ∈ [−0.5, 0.5], y down) to NDC:
   * X = m0·qx + m2·qy + m4, Y = m1·qx + m3·qy + m5.
   */
  readonly m: Float32Array
  /** Crop rectangle in displayed-frame UV (u0, v0, u1, v1), v down. */
  readonly uv: Float32Array
  rotation: Rotation
  opacity: number
  /** Final drawn size in canvas px (before rotation). */
  width: number
  height: number
  /** Source texels per canvas px along x (converts canvas-px sigmas to texel sigmas). */
  texelsPerPx: number
  readonly fx: EffectState
}

export function createLayerState(): LayerState {
  return {
    m: new Float32Array(6),
    uv: new Float32Array(4),
    rotation: 0,
    opacity: 1,
    width: 0,
    height: 0,
    texelsPerPx: 1,
    fx: createEffectState(),
  }
}

export interface LayerContext {
  resolveEffect?: ((ref: string) => EffectPreset | undefined) | undefined
  resolveAnimation?: ((ref: string) => AnimationPreset | undefined) | undefined
}

/** Scratch for sticker animation offsets (module-level: computeLayer is not re-entrant). */
const anim = { opacity: 1, scale: 1, x: 0, y: 0, rotation: 0 }

function applyAnimation(
  a: TextAnimation | undefined,
  kind: 'in' | 'out',
  local: number,
  duration: number,
  ctx: LayerContext,
): void {
  if (!a || !ctx.resolveAnimation) return
  const preset = ctx.resolveAnimation(a.ref)
  if (!preset) return
  const d = Math.max(1, Math.min(a.duration, duration))
  const p = kind === 'in' ? local / d : (local - (duration - d)) / d
  if (p < 0 || p > 1) return
  const v = evaluatePreset(preset, p)
  anim.opacity *= v.opacity
  anim.scale *= v.scale
  anim.x += v.x
  anim.y += v.y
  anim.rotation += v.rotation
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * Compute the layer for `clip` at clip-local time `local` (us). `src` describes the decoded
 * source (texture size and display rotation); for stickers it is the bitmap size.
 */
export function computeLayer(
  clip: MediaClip | StickerClip,
  local: number,
  src: SourceInfo,
  ctx: LayerContext,
  out: LayerState,
): LayerState {
  const tr = clip.transform
  const rot = src.rotation
  const dispW = rot === 90 || rot === 270 ? src.height : src.width
  const dispH = rot === 90 || rot === 270 ? src.width : src.height
  out.rotation = rot

  // crop (stickers have none)
  let u0 = 0
  let v0 = 0
  let u1 = 1
  let v1 = 1
  if (clip.type !== 'sticker') {
    const c = clip.crop
    u0 = clamp01(c.left)
    v0 = clamp01(c.top)
    u1 = Math.max(u0 + 1e-4, 1 - clamp01(c.right))
    v1 = Math.max(v0 + 1e-4, 1 - clamp01(c.bottom))
  }
  out.uv[0] = u0
  out.uv[1] = v0
  out.uv[2] = u1
  out.uv[3] = v1
  const cw = Math.max(1e-6, dispW * (u1 - u0))
  const ch = Math.max(1e-6, dispH * (v1 - v0))

  // base size from fit
  let W: number
  let H: number
  if (clip.type === 'sticker') {
    const s = Math.min(1, CANVAS_W / cw, CANVAS_H / ch)
    W = cw * s
    H = ch * s
  } else if (clip.fit === 'fill') {
    W = CANVAS_W
    H = CANVAS_H
  } else {
    const sx = CANVAS_W / cw
    const sy = CANVAS_H / ch
    const s = clip.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
    W = cw * s
    H = ch * s
  }

  // animation state
  anim.opacity = 1
  anim.scale = 1
  anim.x = 0
  anim.y = 0
  anim.rotation = 0
  let motionScale = 1
  let motionX = 0
  if (clip.type === 'image' && clip.autoMotion !== 'none') {
    const p = clamp01(local / clip.duration)
    const extra = AUTO_MOTION_ZOOM - 1
    switch (clip.autoMotion) {
      case 'zoomIn':
        motionScale = 1 + extra * p
        break
      case 'zoomOut':
        motionScale = AUTO_MOTION_ZOOM - extra * p
        break
      case 'panLeft':
        motionScale = AUTO_MOTION_ZOOM
        motionX = ((W * extra) / 2) * (1 - 2 * p)
        break
      case 'panRight':
        motionScale = AUTO_MOTION_ZOOM
        motionX = ((W * extra) / 2) * (2 * p - 1)
        break
    }
  }
  if (clip.type === 'sticker') {
    applyAnimation(clip.animationIn, 'in', local, clip.duration, ctx)
    applyAnimation(clip.animationOut, 'out', local, clip.duration, ctx)
  }

  const fx = evaluateEffects(
    clip.type === 'sticker' ? NO_EFFECTS : clip.effects,
    local,
    clip.duration,
    ctx.resolveEffect,
    out.fx,
  )

  const scale = evaluate(tr.scale, local) * motionScale * anim.scale * fx.scale
  W *= scale
  H *= scale
  const cx = evaluate(tr.x, local) + motionX + anim.x + fx.dx
  const cy = evaluate(tr.y, local) + anim.y + fx.dy
  const theta = ((evaluate(tr.rotation, local) + anim.rotation) * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const sw = tr.flipH ? -W : W
  const sh = tr.flipV ? -H : H
  const kx = 2 / CANVAS_W
  const ky = 2 / CANVAS_H
  const m = out.m
  m[0] = cos * sw * kx
  m[1] = -sin * sw * ky
  m[2] = -sin * sh * kx
  m[3] = -cos * sh * ky
  m[4] = cx * kx - 1
  m[5] = 1 - cy * ky
  out.width = W
  out.height = H
  out.opacity = clamp01(evaluate(tr.opacity, local) * anim.opacity)
  out.texelsPerPx =
    W > 0 ? ((rot === 90 || rot === 270 ? src.height : src.width) * (u1 - u0)) / W : 1
  return out
}

const NO_EFFECTS: readonly never[] = []

/**
 * Map a displayed-frame UV (v down) to texture UV for a source with clockwise display
 * rotation `r` — the CPU twin of the shader's `rotUV` (used by tests and hit-testing).
 */
export function displayToTexture(u: number, v: number, r: Rotation): [number, number] {
  switch (r) {
    case 0:
      return [u, v]
    case 90:
      return [v, 1 - u]
    case 180:
      return [1 - u, 1 - v]
    case 270:
      return [1 - v, u]
  }
}

/** Gaussian σ (canvas px) of the blurred-fill background behind letterboxed main clips. */
export const BACKGROUND_BLUR_PX = 40

/**
 * Blurred-fill background layer for a main clip: its cropped source cover-fitted to the
 * canvas, centred, untransformed and fully opaque (the compositor blurs it by
 * {@link BACKGROUND_BLUR_PX}). `uv` is the clip's crop (from {@link computeLayer}).
 */
export function computeFill(src: SourceInfo, uv: Float32Array, out: LayerState): LayerState {
  const rot = src.rotation
  const dispW = rot === 90 || rot === 270 ? src.height : src.width
  const dispH = rot === 90 || rot === 270 ? src.width : src.height
  out.uv.set(uv)
  const cw = Math.max(1e-6, dispW * (uv[2]! - uv[0]!))
  const ch = Math.max(1e-6, dispH * (uv[3]! - uv[1]!))
  const s = Math.max(CANVAS_W / cw, CANVAS_H / ch)
  const W = cw * s
  const H = ch * s
  const m = out.m
  m[0] = (W * 2) / CANVAS_W
  m[1] = 0
  m[2] = 0
  m[3] = (-H * 2) / CANVAS_H
  m[4] = 0
  m[5] = 0
  out.rotation = rot
  out.opacity = 1
  out.width = W
  out.height = H
  out.texelsPerPx = cw / W
  resetEffectState(out.fx)
  return out
}

/** Apply a layer matrix to a quad point → canvas px (for tests / hit-testing). */
export function quadToCanvas(m: Float32Array, qx: number, qy: number): [number, number] {
  const X = m[0]! * qx + m[2]! * qy + m[4]!
  const Y = m[1]! * qx + m[3]! * qy + m[5]!
  return [((X + 1) / 2) * CANVAS_W, ((1 - Y) / 2) * CANVAS_H]
}
