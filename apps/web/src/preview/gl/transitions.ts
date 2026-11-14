/**
 * Main-track transitions.
 *
 * The 24 standard types are ports of FFmpeg's `xfade` filter (libavfilter/vf_xfade.c) so the
 * preview matches the export pixel-for-pixel up to sampling. Conventions copied from xfade:
 * - `progress` runs 1 → 0 across the transition (1 = only A, the outgoing clip).
 * - Pixel coordinates are integer (x, y) with y down; w, h are the frame size in px.
 * - `mix(a, b, m) = a·m + b·(1 − m)` (note: the REVERSE of GLSL's mix).
 * - `smoothstep` is the clamped Hermite (identical to GLSL's for edge0 < edge1).
 *
 * The four trend types (whip, flash, glitch, spin) have no xfade equivalent; their formulas
 * are defined here and written so they can be expressed with xfade's `custom` expression
 * (A/B sampling functions, X/Y/W/H/P). The render compiler must use the same formulas.
 *
 * `transitionRef` is the CPU reference used by tests (checked against real FFmpeg output);
 * {@link TRANSITION_GLSL} mirrors it line by line for the GPU.
 */
import { TransitionType } from '@reelforge/core'

/** Stable integer id per transition type (shader uniform). */
export const TRANSITION_ID: Readonly<Record<TransitionType, number>> = Object.fromEntries(
  TransitionType.options.map((t, i) => [t, i]),
) as Record<TransitionType, number>

/** Plane sampler: value of input A or B at integer pixel (x, y), channel c (0..2). */
export interface TransitionInputs {
  w: number
  h: number
  a(x: number, y: number, c: number): number
  b(x: number, y: number, c: number): number
  /** Full-scale value (255 for 8-bit, 1 for normalised floats). */
  max: number
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const ffmix = (a: number, b: number, m: number): number => a * m + b * (1 - m)
const fract = (x: number): number => x - Math.floor(x)
const f32 = Math.fround

/** xfade's dissolve hash (float32 like the C code). */
export function frand(x: number, y: number): number {
  const r = f32(Math.sin(f32(f32(x * f32(12.9898)) + f32(y * f32(78.233)))) * f32(43758.545))
  return f32(r - Math.floor(r))
}

/** Easing used by the trend transitions (cubic in-out). */
export const easeInOutCubic = (p: number): number =>
  p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2

/** Number of taps of the whip blur and the hblur approximation on the GPU. */
export const WHIP_TAPS = 12
export const HBLUR_TAPS = 32

/**
 * Hash in [0, 1) used by glitch (Dave Hoskins' "hash without sine"; same constants as the
 * GLSL). Sine-based hashes of large arguments differ completely between GPUs (and from f64),
 * while every intermediate here stays small enough for f32 to agree with f64 to ~1e-4 —
 * and it is plain arithmetic, so FFmpeg expressions can reproduce it for the export.
 */
export function hash11(n: number): number {
  let p = fract(n * 0.1031)
  p *= p + 33.33
  p *= p + p
  return fract(p)
}

/**
 * Values of xfade's dissolve hash for a w×h frame (row-major, y down). GPU `sin()` is far too
 * imprecise for the large arguments of this hash, so the compositor uploads this table as a
 * texture instead of evaluating the hash in GLSL — making the GPU dissolve match xfade exactly.
 */
export function dissolveNoise(w: number, h: number, out = new Float32Array(w * h)): Float32Array {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = frand(x, y)
  }
  return out
}

/**
 * CPU reference of one output sample of transition `type` at pixel (x, y), channel c, with
 * xfade `progress` (1 → 0). Returns an unclamped value in the inputs' scale.
 */
export function transitionRef(
  type: TransitionType,
  I: TransitionInputs,
  x: number,
  y: number,
  c: number,
  progress: number,
): number {
  const { w, h } = I
  const A = (xx: number, yy: number): number => I.a(xx, yy, c)
  const B = (xx: number, yy: number): number => I.b(xx, yy, c)
  switch (type) {
    case 'fade':
      return ffmix(A(x, y), B(x, y), progress)
    case 'fadeblack':
    case 'fadewhite': {
      const bg = type === 'fadeblack' ? 0 : I.max
      const phase = 0.2
      return ffmix(
        ffmix(A(x, y), bg, smoothstep(1 - phase, 1, progress)),
        ffmix(bg, B(x, y), smoothstep(phase, 1, progress)),
        progress,
      )
    }
    case 'dissolve': {
      const r = frand(x, y)
      return r * 2 + progress * 2 - 1.5 >= 0.5 ? A(x, y) : B(x, y)
    }
    case 'wipeleft': {
      const z = Math.trunc(progress * w)
      return x > z ? B(x, y) : A(x, y)
    }
    case 'wiperight': {
      const z = Math.trunc(w * (1 - progress))
      return x > z ? A(x, y) : B(x, y)
    }
    case 'wipeup': {
      const z = Math.trunc(progress * h)
      return y > z ? B(x, y) : A(x, y)
    }
    case 'wipedown': {
      const z = Math.trunc(h * (1 - progress))
      return y > z ? A(x, y) : B(x, y)
    }
    case 'slideleft':
    case 'slideright': {
      const z = Math.trunc(type === 'slideleft' ? -progress * w : progress * w)
      const zx = z + x
      const zz = (zx % w) + (zx < 0 ? w : 0)
      return zx >= 0 && zx < w ? B(zz, y) : A(zz, y)
    }
    case 'slideup':
    case 'slidedown': {
      const z = Math.trunc(type === 'slideup' ? -progress * h : progress * h)
      const zy = z + y
      const zz = (zy % h) + (zy < 0 ? h : 0)
      return zy >= 0 && zy < h ? B(x, zz) : A(x, zz)
    }
    case 'smoothleft':
      return ffmix(B(x, y), A(x, y), smoothstep(0, 1, 1 + x / w - progress * 2))
    case 'smoothright':
      return ffmix(B(x, y), A(x, y), smoothstep(0, 1, 1 + (w - 1 - x) / w - progress * 2))
    case 'smoothup':
      return ffmix(B(x, y), A(x, y), smoothstep(0, 1, 1 + y / h - progress * 2))
    case 'smoothdown':
      return ffmix(B(x, y), A(x, y), smoothstep(0, 1, 1 + (h - 1 - y) / h - progress * 2))
    case 'circleopen':
    case 'circleclose': {
      const cx = Math.trunc(w / 2)
      const cy = Math.trunc(h / 2)
      const z = Math.hypot(cx, cy)
      const d = Math.hypot(x - cx, y - cy) / z
      if (type === 'circleopen') {
        const p = (progress - 0.5) * 3
        return ffmix(A(x, y), B(x, y), smoothstep(0, 1, d + p))
      }
      const p = (1 - progress - 0.5) * 3
      return ffmix(B(x, y), A(x, y), smoothstep(0, 1, d + p))
    }
    case 'radial': {
      const s = Math.atan2(x - w / 2, y - h / 2) - (progress - 0.5) * (Math.PI * 2.5)
      return ffmix(B(x, y), A(x, y), smoothstep(0, 1, s))
    }
    case 'zoomin': {
      const zf = smoothstep(0.5, 1, progress)
      const u = (x / w - 0.5) * zf + 0.5
      const v = (y / h - 0.5) * zf + 0.5
      const iu = Math.ceil(u * (w - 1))
      const iv = Math.ceil(v * (h - 1))
      return ffmix(A(iu, iv), B(x, y), smoothstep(0, 0.5, progress))
    }
    case 'pixelize': {
      // block edges land exactly on integer pixels, so float32 rounding decides which side
      // a pixel falls on: emulate the C float math step by step (the GPU is float32 too)
      const pf = f32(progress)
      const d = Math.min(pf, f32(1 - pf))
      const dist = f32(Math.ceil(f32(d * 50)) / 50)
      const sq = f32(f32(f32(2 * dist) * Math.min(w, h)) / 20)
      const block = (v: number, max: number): number =>
        Math.trunc(Math.min(f32(f32(Math.floor(f32(v / sq)) + 0.5) * sq), max))
      const sx = dist > 0 ? block(x, w - 1) : x
      const sy = dist > 0 ? block(y, h - 1) : y
      return ffmix(A(sx, sy), B(sx, sy), progress)
    }
    case 'hblur': {
      // xfade: forward-looking running box of `size` px, shrinking at the right edge
      const prog = progress <= 0.5 ? progress * 2 : (1 - progress) * 2
      const size = Math.trunc(1 + (w / 2) * prog)
      let s0 = 0
      let s1 = 0
      let n = 0
      for (let k = x; k < Math.min(w, x + size); k++) {
        s0 += A(k, y)
        s1 += B(k, y)
        n++
      }
      return ffmix(s0 / n, s1 / n, progress)
    }
    case 'squeezeh': {
      const z = 0.5 + (y / h - 0.5) / progress
      if (z < 0 || z > 1) return B(x, y)
      return A(x, Math.round(z * (h - 1)))
    }
    case 'squeezev': {
      const z = 0.5 + (x / w - 0.5) / progress
      if (z < 0 || z > 1) return B(x, y)
      return A(Math.round(z * (w - 1)), y)
    }
    case 'whip':
      return whipRef(I, x, y, c, 1 - progress)
    case 'flash': {
      const p = 1 - progress
      const k = smoothstep(0, 1, 1 - Math.abs(2 * p - 1))
      const base = p < 0.5 ? A(x, y) : B(x, y)
      return base + (I.max - base) * k
    }
    case 'glitch':
      return glitchRef(I, x, y, c, 1 - progress)
    case 'spin':
      return spinRef(I, x, y, c, 1 - progress)
  }
}

const clampi = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Sample the virtual strip [A | B] (B to the right of A) at horizontal position xs. */
function strip(I: TransitionInputs, xs: number, y: number, c: number): number {
  const xi = Math.floor(xs)
  return xi < I.w ? I.a(clampi(xi, 0, I.w - 1), y, c) : I.b(clampi(xi - I.w, 0, I.w - 1), y, c)
}

/**
 * whip: A slides out to the left while B slides in (cubic ease), with a horizontal motion
 * blur of up to 15 % of the width that peaks mid-transition. `p` is forward progress 0..1.
 */
function whipRef(I: TransitionInputs, x: number, y: number, c: number, p: number): number {
  const shift = easeInOutCubic(p) * I.w
  const blur = 0.15 * I.w * Math.sin(Math.PI * p)
  let sum = 0
  for (let k = 0; k < WHIP_TAPS; k++) {
    sum += strip(I, x + shift + (k / (WHIP_TAPS - 1) - 0.5) * blur, y, c)
  }
  return sum / WHIP_TAPS
}

/**
 * glitch: hard cut at the midpoint, with per-band horizontal tearing (16 bands, re-rolled 20×
 * per transition) and an RGB split, both scaled by sin(π·p).
 */
function glitchRef(I: TransitionInputs, x: number, y: number, c: number, p: number): number {
  const g = Math.sin(Math.PI * p)
  const band = Math.floor((y / I.h) * 16)
  // f32 like the shader: progress values on a step boundary must pick the same band offsets
  const step = Math.floor(f32(f32(p) * 20))
  const d = (hash11(band * 31 + step) - 0.5) * 0.1 * I.w * g
  const split = (c === 0 ? 0.02 : c === 2 ? -0.02 : 0) * I.w * g
  const xs = clampi(Math.floor(x + d + split), 0, I.w - 1)
  return p < 0.5 ? I.a(xs, y, c) : I.b(xs, y, c)
}

/**
 * spin: rotate one full turn (cubic ease) about the centre while zooming in up to 2.5× at the
 * midpoint, cross-fading A→B between 40 % and 60 %. Out-of-frame samples clamp to the edge.
 */
function spinRef(I: TransitionInputs, x: number, y: number, c: number, p: number): number {
  const theta = easeInOutCubic(p) * Math.PI * 2
  const z = 1 + 1.5 * Math.sin(Math.PI * p)
  const cx = I.w / 2
  const cy = I.h / 2
  const dx = (x + 0.5 - cx) / z
  const dy = (y + 0.5 - cy) / z
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const sx = clampi(Math.floor(cx + cos * dx - sin * dy), 0, I.w - 1)
  const sy = clampi(Math.floor(cy + sin * dx + cos * dy), 0, I.h - 1)
  return ffmix(I.b(sx, sy, c), I.a(sx, sy, c), smoothstep(0.4, 0.6, p))
}

/**
 * CPU twin of the GPU hblur, which approximates xfade's exact running box (up to w/2 taps)
 * with {@link HBLUR_TAPS} evenly spaced taps over the same window.
 */
export function hblurApprox(
  I: TransitionInputs,
  x: number,
  y: number,
  c: number,
  progress: number,
): number {
  const prog = progress <= 0.5 ? progress * 2 : (1 - progress) * 2
  const size = Math.trunc(1 + (I.w / 2) * prog)
  const end = Math.min(I.w, x + size)
  const n = Math.min(HBLUR_TAPS, end - x)
  let s0 = 0
  let s1 = 0
  for (let k = 0; k < n; k++) {
    const xs = Math.floor(x + ((k + 0.5) * (end - x)) / n)
    s0 += I.a(xs, y, c)
    s1 += I.b(xs, y, c)
  }
  return ffmix(s0 / n, s1 / n, progress)
}

/**
 * GLSL ES 3.00 fragment shader body. Inputs A/B are full-frame textures of size uSize in
 * which row 0 is the BOTTOM of the picture (FBO convention); pixel (x, y) here is y-down like
 * xfade. Values are normalised (max = 1).
 */
export const TRANSITION_GLSL = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uA;
uniform sampler2D uB;
uniform highp sampler2D uNoise; // dissolveNoise() table (R32F, row = picture y)
uniform int uType;
uniform float uProgress;
uniform vec2 uSize;
out vec4 outColor;

const float PI = 3.141592653589793;

vec4 tA(float x, float y) {
  ivec2 s = ivec2(uSize);
  ivec2 q = clamp(ivec2(int(x), int(y)), ivec2(0), s - 1);
  return texelFetch(uA, ivec2(q.x, s.y - 1 - q.y), 0);
}
vec4 tB(float x, float y) {
  ivec2 s = ivec2(uSize);
  ivec2 q = clamp(ivec2(int(x), int(y)), ivec2(0), s - 1);
  return texelFetch(uB, ivec2(q.x, s.y - 1 - q.y), 0);
}
vec4 ffmix(vec4 a, vec4 b, float m) { return a * m + b * (1.0 - m); }
float easeInOutCubic(float p) {
  return p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) / 2.0;
}
float hash11(float n) {
  float p = fract(n * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec4 strip(float xs, float y) {
  float xi = floor(xs);
  return xi < uSize.x ? tA(xi, y) : tB(xi - uSize.x, y);
}

void main() {
  float w = uSize.x;
  float h = uSize.y;
  float x = floor(gl_FragCoord.x);
  float y = h - 1.0 - floor(gl_FragCoord.y);
  float P = uProgress;
  vec4 a = tA(x, y);
  vec4 b = tB(x, y);
  vec4 o = a;
  switch (uType) {
    case ${TRANSITION_ID.fade}: o = ffmix(a, b, P); break;
    case ${TRANSITION_ID.fadeblack}:
    case ${TRANSITION_ID.fadewhite}: {
      vec4 bg = uType == ${TRANSITION_ID.fadeblack} ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0);
      o = ffmix(ffmix(a, bg, smoothstep(0.8, 1.0, P)), ffmix(bg, b, smoothstep(0.2, 1.0, P)), P);
      break;
    }
    case ${TRANSITION_ID.dissolve}: o = texelFetch(uNoise, ivec2(x, y), 0).r * 2.0 + P * 2.0 - 1.5 >= 0.5 ? a : b; break;
    case ${TRANSITION_ID.wipeleft}: o = x > floor(P * w) ? b : a; break;
    case ${TRANSITION_ID.wiperight}: o = x > floor(w * (1.0 - P)) ? a : b; break;
    case ${TRANSITION_ID.wipeup}: o = y > floor(P * h) ? b : a; break;
    case ${TRANSITION_ID.wipedown}: o = y > floor(h * (1.0 - P)) ? a : b; break;
    case ${TRANSITION_ID.slideleft}:
    case ${TRANSITION_ID.slideright}: {
      float z = trunc(uType == ${TRANSITION_ID.slideleft} ? -P * w : P * w);
      float zx = z + x;
      float zz = zx - w * trunc(zx / w) + (zx < 0.0 ? w : 0.0);
      o = (zx >= 0.0 && zx < w) ? tB(zz, y) : tA(zz, y);
      break;
    }
    case ${TRANSITION_ID.slideup}:
    case ${TRANSITION_ID.slidedown}: {
      float z = trunc(uType == ${TRANSITION_ID.slideup} ? -P * h : P * h);
      float zy = z + y;
      float zz = zy - h * trunc(zy / h) + (zy < 0.0 ? h : 0.0);
      o = (zy >= 0.0 && zy < h) ? tB(x, zz) : tA(x, zz);
      break;
    }
    case ${TRANSITION_ID.smoothleft}: o = ffmix(b, a, smoothstep(0.0, 1.0, 1.0 + x / w - P * 2.0)); break;
    case ${TRANSITION_ID.smoothright}: o = ffmix(b, a, smoothstep(0.0, 1.0, 1.0 + (w - 1.0 - x) / w - P * 2.0)); break;
    case ${TRANSITION_ID.smoothup}: o = ffmix(b, a, smoothstep(0.0, 1.0, 1.0 + y / h - P * 2.0)); break;
    case ${TRANSITION_ID.smoothdown}: o = ffmix(b, a, smoothstep(0.0, 1.0, 1.0 + (h - 1.0 - y) / h - P * 2.0)); break;
    case ${TRANSITION_ID.circleopen}:
    case ${TRANSITION_ID.circleclose}: {
      vec2 c = floor(uSize / 2.0);
      float d = length(vec2(x, y) - c) / length(c);
      o = uType == ${TRANSITION_ID.circleopen}
        ? ffmix(a, b, smoothstep(0.0, 1.0, d + (P - 0.5) * 3.0))
        : ffmix(b, a, smoothstep(0.0, 1.0, d + (0.5 - P) * 3.0));
      break;
    }
    case ${TRANSITION_ID.radial}: {
      float s = atan(x - w / 2.0, y - h / 2.0) - (P - 0.5) * (PI * 2.5);
      o = ffmix(b, a, smoothstep(0.0, 1.0, s));
      break;
    }
    case ${TRANSITION_ID.zoomin}: {
      float zf = smoothstep(0.5, 1.0, P);
      float u = (x / w - 0.5) * zf + 0.5;
      float v = (y / h - 0.5) * zf + 0.5;
      o = ffmix(tA(ceil(u * (w - 1.0)), ceil(v * (h - 1.0))), b, smoothstep(0.0, 0.5, P));
      break;
    }
    case ${TRANSITION_ID.pixelize}: {
      float dist = ceil(min(P, 1.0 - P) * 50.0) / 50.0;
      float sq = 2.0 * dist * min(w, h) / 20.0;
      float sx = dist > 0.0 ? trunc(min((floor(x / sq) + 0.5) * sq, w - 1.0)) : x;
      float sy = dist > 0.0 ? trunc(min((floor(y / sq) + 0.5) * sq, h - 1.0)) : y;
      o = ffmix(tA(sx, sy), tB(sx, sy), P);
      break;
    }
    case ${TRANSITION_ID.hblur}: {
      float prog = P <= 0.5 ? P * 2.0 : (1.0 - P) * 2.0;
      float size = trunc(1.0 + (w / 2.0) * prog);
      float e = min(w, x + size);
      float n = min(${HBLUR_TAPS}.0, e - x);
      vec4 s0 = vec4(0.0);
      vec4 s1 = vec4(0.0);
      for (int k = 0; k < ${HBLUR_TAPS}; k++) {
        if (float(k) >= n) break;
        float xs = floor(x + (float(k) + 0.5) * (e - x) / n);
        s0 += tA(xs, y);
        s1 += tB(xs, y);
      }
      o = ffmix(s0 / n, s1 / n, P);
      break;
    }
    case ${TRANSITION_ID.squeezeh}: {
      float z = 0.5 + (y / h - 0.5) / P;
      o = (z < 0.0 || z > 1.0) ? b : tA(x, floor(z * (h - 1.0) + 0.5));
      break;
    }
    case ${TRANSITION_ID.squeezev}: {
      float z = 0.5 + (x / w - 0.5) / P;
      o = (z < 0.0 || z > 1.0) ? b : tA(floor(z * (w - 1.0) + 0.5), y);
      break;
    }
    case ${TRANSITION_ID.whip}: {
      float p = 1.0 - P;
      float shift = easeInOutCubic(p) * w;
      float blur = 0.15 * w * sin(PI * p);
      vec4 s = vec4(0.0);
      for (int k = 0; k < ${WHIP_TAPS}; k++) {
        s += strip(x + shift + (float(k) / ${WHIP_TAPS - 1}.0 - 0.5) * blur, y);
      }
      o = s / ${WHIP_TAPS}.0;
      break;
    }
    case ${TRANSITION_ID.flash}: {
      float p = 1.0 - P;
      float k = smoothstep(0.0, 1.0, 1.0 - abs(2.0 * p - 1.0));
      vec4 base = p < 0.5 ? a : b;
      o = base + (vec4(1.0) - base) * k;
      break;
    }
    case ${TRANSITION_ID.glitch}: {
      float p = 1.0 - P;
      float g = sin(PI * p);
      float band = floor(y / h * 16.0);
      float d = (hash11(band * 31.0 + floor(p * 20.0)) - 0.5) * 0.1 * w * g;
      float sp = 0.02 * w * g;
      vec4 base = vec4(0.0);
      if (p < 0.5) {
        base = vec4(tA(floor(x + d + sp), y).r, tA(floor(x + d), y).g, tA(floor(x + d - sp), y).b, 1.0);
      } else {
        base = vec4(tB(floor(x + d + sp), y).r, tB(floor(x + d), y).g, tB(floor(x + d - sp), y).b, 1.0);
      }
      o = base;
      break;
    }
    case ${TRANSITION_ID.spin}: {
      float p = 1.0 - P;
      float th = easeInOutCubic(p) * PI * 2.0;
      float z = 1.0 + 1.5 * sin(PI * p);
      vec2 c = uSize / 2.0;
      vec2 dd = (vec2(x, y) + 0.5 - c) / z;
      vec2 s = floor(c + vec2(cos(th) * dd.x - sin(th) * dd.y, sin(th) * dd.x + cos(th) * dd.y));
      o = ffmix(tB(s.x, s.y), tA(s.x, s.y), smoothstep(0.4, 0.6, p));
      break;
    }
    default: break;
  }
  outColor = vec4(o.rgb, 1.0);
}
`
