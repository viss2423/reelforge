/**
 * CPU twin of the layer shader's AI-background compositing (gl/shaders.ts, `uBgMode`), which
 * in turn mirrors the export's FFmpeg graph (core compile/visual.ts `decodeMedia`):
 *
 *   remove  out = fg · m          (premultiplied over transparent → shows what is below)
 *   blur    out = lerp(blur(fg), fg, m)
 *   colour  out = lerp(colour, fg, m)
 *   image   out = lerp(image, fg, m)
 *
 * with `m` the matte alpha (0..1). Channels are in 0..1. Used by the GPU self-check and the
 * parity tests; the export applies the same lerp in `alphamerge` + `overlay`.
 */

export type BackgroundKind = 'remove' | 'blur' | 'color' | 'image'

/** Premultiplied RGB a layer contributes to the frame for one pixel. */
export function compositeBackground(
  kind: BackgroundKind,
  fg: number,
  back: number,
  m: number,
): number {
  if (kind === 'remove') return fg * m
  return back + (fg - back) * m
}

/** Matte value (0..1) from an 8-bit gray/R sample. */
export const matteValue = (code: number): number => code / 255
