/** Geometry for the 9:16 preview surface. */

export const CANVAS_ASPECT = 9 / 16
/** Above 2× the extra pixels cost GPU time on phones without a visible gain at preview size. */
export const MAX_DPR = 2

/** Largest 9:16 box (CSS px, integer) that fits in a container. */
export const fitAspect = (
  width: number,
  height: number,
  aspect = CANVAS_ASPECT,
): { width: number; height: number } => {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  // Derive the height from the floored width so the box never exceeds 9:16 by rounding.
  const w = Math.floor(Math.min(width, height * aspect))
  return { width: w, height: Math.floor(w / aspect) }
}

/** Backing-store size for a CSS box at a device pixel ratio (capped). */
export const backingSize = (
  css: { width: number; height: number },
  dpr: number,
): { width: number; height: number } => {
  const r = Math.min(MAX_DPR, Math.max(1, dpr || 1))
  return { width: Math.round(css.width * r), height: Math.round(css.height * r) }
}
