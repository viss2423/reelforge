/**
 * Dual-filter (Kawase) blur: n downsample passes then n upsample passes. Each pass is 5 or
 * 8 bilinear taps on a progressively smaller target, so a σ = 40 px blur costs about as
 * much as a single full-resolution copy — essential for blurred-fill backgrounds on phones.
 *
 * The (levels, offset) → Gaussian σ relationship was measured with {@link simulateDualKawase}
 * (a CPU twin of the two shaders) and is tabulated below; tests verify that the plan for
 * a requested σ lands within tolerance of it.
 */
import { bindTarget, createTarget, deleteTarget, type Program, type Target } from './context.ts'

/** Offsets at which σ was measured. */
const OFFSETS = [0.5, 1, 1.5, 2, 3] as const
/**
 * σ / 2ⁿ (source px) per level count n (index n − 1; deeper levels use the last row) for each
 * of {@link OFFSETS}. Measured with simulateDualKawase on a 256² impulse.
 */
const SIGMA_PER_SCALE = [
  [0.48, 0.84, 1.07, 1.42, 2.09],
  [0.535, 0.94, 1.17, 1.61, 2.34],
  [0.549, 0.964, 1.194, 1.652, 2.396],
  [0.552, 0.97, 1.2, 1.663, 2.41],
] as const

export const MAX_LEVELS = 6
/** Below this σ (px) blurring is invisible and skipped. */
export const MIN_SIGMA = 0.4
/** Offset range kept for quality: below 1 the kernel gets boxy, above 2 it rings. */
const MAX_OFFSET = 2

export interface KawasePlan {
  levels: number
  offset: number
}

const row = (n: number): readonly number[] =>
  SIGMA_PER_SCALE[Math.min(n, SIGMA_PER_SCALE.length) - 1]!

/** σ (source px) produced by `levels` passes at `offset`. */
export function kawaseSigma(levels: number, offset: number): number {
  const r = row(levels)
  let i = 0
  while (i < OFFSETS.length - 2 && offset > OFFSETS[i + 1]!) i++
  const o0 = OFFSETS[i]!
  const o1 = OFFSETS[i + 1]!
  const k = (offset - o0) / (o1 - o0)
  return (r[i]! + (r[i + 1]! - r[i]!) * k) * 2 ** levels
}

/**
 * Plan for a Gaussian-equivalent σ in source px, limited so the smallest level is at least
 * 2 px on the short side of a `minSide`-px texture. Returns null when σ is negligible.
 */
export function kawasePlan(sigma: number, minSide = 4096): KawasePlan | null {
  if (!(sigma >= MIN_SIGMA)) return null
  const maxLevels = Math.max(
    1,
    Math.min(MAX_LEVELS, Math.floor(Math.log2(Math.max(2, minSide) / 2))),
  )
  let levels = 1
  while (levels < maxLevels && kawaseSigma(levels, MAX_OFFSET) < sigma) levels++
  // invert the (monotonic) offset curve by bisection
  let lo: number = OFFSETS[0]
  let hi: number = levels === maxLevels ? OFFSETS[OFFSETS.length - 1]! : MAX_OFFSET
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2
    if (kawaseSigma(levels, mid) < sigma) lo = mid
    else hi = mid
  }
  return { levels, offset: (lo + hi) / 2 }
}

/* ------------------------------------------------------------------ CPU twin (tests/calibration) */

function bilinear(img: Float64Array, w: number, h: number, u: number, v: number): number {
  const x = u * w - 0.5
  const y = v * h - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const at = (i: number, j: number): number =>
    img[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))]!
  return (
    (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
    (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  )
}

/**
 * Run the dual-filter passes on a single-channel image exactly as the shaders do (uOff of a
 * down pass = offset/srcSize, of an up pass = offset·0.5/srcSize). Returns the result at
 * the input size.
 */
export function simulateDualKawase(
  input: Float64Array,
  width: number,
  height: number,
  plan: KawasePlan,
): Float64Array {
  let img = input
  let w = width
  let h = height
  const sizes: Array<[number, number]> = []
  for (let k = 0; k < plan.levels; k++) {
    sizes.push([w, h])
    const W = Math.max(1, w >> 1)
    const H = Math.max(1, h >> 1)
    const out = new Float64Array(W * H)
    const ox = plan.offset / w
    const oy = plan.offset / h
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const u = (i + 0.5) / W
        const v = (j + 0.5) / H
        out[j * W + i] =
          (bilinear(img, w, h, u, v) * 4 +
            bilinear(img, w, h, u - ox, v - oy) +
            bilinear(img, w, h, u + ox, v + oy) +
            bilinear(img, w, h, u + ox, v - oy) +
            bilinear(img, w, h, u - ox, v + oy)) /
          8
      }
    }
    img = out
    w = W
    h = H
  }
  for (let k = plan.levels - 1; k >= 0; k--) {
    const [W, H] = sizes[k]!
    const out = new Float64Array(W * H)
    const ox = (plan.offset * 0.5) / w
    const oy = (plan.offset * 0.5) / h
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const u = (i + 0.5) / W
        const v = (j + 0.5) / H
        const s = (a: number, b: number): number => bilinear(img, w, h, u + a, v + b)
        out[j * W + i] =
          (s(-2 * ox, 0) +
            s(-ox, oy) * 2 +
            s(0, 2 * oy) +
            s(ox, oy) * 2 +
            s(2 * ox, 0) +
            s(ox, -oy) * 2 +
            s(0, -2 * oy) +
            s(-ox, -oy) * 2) /
          12
      }
    }
    img = out
    w = W
    h = H
  }
  return img
}

/* ------------------------------------------------------------------ GPU executor */

/**
 * Executes plans on the GPU with a per-level pool of targets (re-created only when the
 * source size changes), so steady-state blurring allocates nothing.
 */
export class DualKawase {
  readonly #gl: WebGL2RenderingContext
  readonly #down: Program
  readonly #up: Program
  readonly #quad: WebGLVertexArrayObject
  /** Pools keyed by "w×h" of level 0 → per-level targets (down chain; up reuses them). */
  readonly #pools = new Map<string, { targets: Target[]; out: Target; used: number }>()

  constructor(
    gl: WebGL2RenderingContext,
    down: Program,
    up: Program,
    quad: WebGLVertexArrayObject,
  ) {
    this.#gl = gl
    this.#down = down
    this.#up = up
    this.#quad = quad
  }

  /**
   * Blur `src` (w×h) by `plan`; returns a texture of the same size valid until the same
   * pool slot is reused. `slot` distinguishes concurrent results of equal size in a frame.
   */
  run(src: WebGLTexture, w: number, h: number, plan: KawasePlan, slot: number): WebGLTexture {
    const gl = this.#gl
    const key = `${w}x${h}#${slot}`
    let pool = this.#pools.get(key)
    if (!pool) {
      pool = { targets: [], out: createTarget(gl, w, h), used: 0 }
      let lw = w
      let lh = h
      for (let k = 0; k < MAX_LEVELS; k++) {
        lw = Math.max(1, lw >> 1)
        lh = Math.max(1, lh >> 1)
        pool.targets.push(createTarget(gl, lw, lh))
      }
      this.#pools.set(key, pool)
    }
    pool.used = performance.now()
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.#quad)
    gl.activeTexture(gl.TEXTURE0)
    // down chain
    gl.useProgram(this.#down.program)
    gl.uniform1i(this.#down.u('uSrc'), 0)
    let tex = src
    let sw = w
    let sh = h
    for (let k = 0; k < plan.levels; k++) {
      const t = pool.targets[k]!
      bindTarget(gl, t, 0, 0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform2f(this.#down.u('uOff'), plan.offset / sw, plan.offset / sh)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      tex = t.tex
      sw = t.width
      sh = t.height
    }
    // up chain back to full size
    gl.useProgram(this.#up.program)
    gl.uniform1i(this.#up.u('uSrc'), 0)
    for (let k = plan.levels - 2; k >= -1; k--) {
      const t = k >= 0 ? pool.targets[k]! : pool.out
      bindTarget(gl, t, 0, 0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform2f(this.#up.u('uOff'), (plan.offset * 0.5) / sw, (plan.offset * 0.5) / sh)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      tex = t.tex
      sw = t.width
      sh = t.height
    }
    return pool.out.tex
  }

  /** Free pools unused for `idleMs` (source sizes change rarely; this bounds GPU memory). */
  trim(idleMs: number): void {
    const now = performance.now()
    for (const [k, p] of this.#pools) {
      if (now - p.used < idleMs) continue
      for (const t of p.targets) deleteTarget(this.#gl, t)
      deleteTarget(this.#gl, p.out)
      this.#pools.delete(k)
    }
  }

  dispose(): void {
    for (const p of this.#pools.values()) {
      for (const t of p.targets) deleteTarget(this.#gl, t)
      deleteTarget(this.#gl, p.out)
    }
    this.#pools.clear()
  }
}
