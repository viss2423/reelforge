/**
 * Affine warps implemented with FFmpeg's `perspective` filter.
 *
 * Per-frame geometry is the expensive part of any compositor. In FFmpeg, per-frame `scale`
 * (eval=frame) and `zoompan` re-initialise a scaler every frame (~25 ms/frame at 1080×1920
 * on the reference Ryzen 7 8840U), whereas `perspective` with eval=frame only recomputes
 * its coordinate table (~11 ms/frame) and samples with sub-pixel (bilinear/bicubic)
 * precision — so Ken Burns and keyframed zooms are smooth instead of stepping in whole
 * pixels. The warp is expressed as the inverse mapping output → source.
 *
 * With `sense=source` (default), corner i of the OUTPUT frame shows source point (xi, yi):
 * 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right. Out-of-range samples
 * clamp to the edge, so callers only use it when the warp provably covers the frame.
 */
import { num } from './expr.ts'
import { filter } from './escape.ts'

/** Inverse affine map from output pixel coordinates to source pixel coordinates. */
export interface InverseAffine {
  /** Expressions (in terms of the time variable already substituted) for the source point. */
  map(u: number, v: number): { x: string; y: string }
}

/**
 * Inverse of "scale by `z` and rotate clockwise by `theta` (radians) about the output point
 * (ocx, ocy), placing source point (scx, scy) there". All arguments are expressions.
 */
export function rotateZoomInverse(o: {
  ocx: string
  ocy: string
  scx: string
  scy: string
  z: string
  theta: string | undefined
}): InverseAffine {
  return {
    map(u, v) {
      const dx = `(${num(u)}-${o.ocx})`
      const dy = `(${num(v)}-${o.ocy})`
      if (o.theta === undefined) {
        return { x: `(${o.scx}+${dx}/${o.z})`, y: `(${o.scy}+${dy}/${o.z})` }
      }
      const c = `cos(${o.theta})`
      const s = `sin(${o.theta})`
      return {
        x: `(${o.scx}+(${dx}*${c}+${dy}*${s})/${o.z})`,
        y: `(${o.scy}+(${dy}*${c}-${dx}*${s})/${o.z})`,
      }
    },
  }
}

/** `perspective` filter for an output of size w×h using the inverse map. */
export function perspectiveFilter(
  w: number,
  h: number,
  inv: InverseAffine,
  opts: { interpolation?: 'linear' | 'cubic'; enable?: string } = {},
): string {
  const p0 = inv.map(0, 0)
  const p1 = inv.map(w, 0)
  const p2 = inv.map(0, h)
  const p3 = inv.map(w, h)
  return filter('perspective', {
    x0: p0.x,
    y0: p0.y,
    x1: p1.x,
    y1: p1.y,
    x2: p2.x,
    y2: p2.y,
    x3: p3.x,
    y3: p3.y,
    interpolation: opts.interpolation ?? 'linear',
    eval: 'frame',
    enable: opts.enable,
  })
}

/** JS evaluation of the same inverse map (for coverage checks and tests). */
export function inverseAffinePoint(
  u: number,
  v: number,
  o: { ocx: number; ocy: number; scx: number; scy: number; z: number; theta: number },
): { x: number; y: number } {
  const dx = u - o.ocx
  const dy = v - o.ocy
  const c = Math.cos(o.theta)
  const s = Math.sin(o.theta)
  return { x: o.scx + (dx * c + dy * s) / o.z, y: o.scy + (dy * c - dx * s) / o.z }
}
