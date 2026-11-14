/**
 * GPU self-check: renders every colour/transition path of the REAL compositor (gl/*.ts
 * shaders) into a small 9:16 target and compares each pixel with the CPU references that the
 * unit tests verify against FFmpeg. Closes the loop "FFmpeg ≈ CPU reference ≈ GLSL".
 *
 * Exposes `window.__rfGpuCheck` (a promise of {@link GpuCheckResult}s) for gl/gpu.test.ts,
 * which runs this page in Chromium via Playwright; open dev/gpucheck.html to see it by hand.
 */
import { Adjustments, ChromaKey, MediaClip, TransitionType } from '@reelforge/core'
import { adjustParams, applyAdjustmentsCpu } from '../color/adjustments.ts'
import { parseCube, sampleTetrahedral } from '../color/cube.ts'
import {
  BLEND_ID,
  chromaKeyAlpha,
  compositeChannel,
  keyUV,
  type BlendMode,
} from '../color/keying.ts'
import { adjustUniforms, chromaKeyUniforms } from '../color/uniforms.ts'
import { Compositor, createLayerDraw, type LayerDraw } from '../gl/compositor.ts'
import { LutStore } from '../gl/lut.ts'
import {
  hblurApprox,
  TRANSITION_ID,
  transitionRef,
  type TransitionInputs,
} from '../gl/transitions.ts'
import { computeLayer } from '../timeline/layers.ts'
import { warmCube } from './demoProject.ts'

/** Per-check error statistics in 8-bit code values. */
export interface GpuCheckResult {
  name: string
  /** Largest absolute difference over all compared samples. */
  maxErr: number
  /** Fraction of samples differing by more than {@link TOLERANCE}. */
  badFrac: number
  samples: number
}

/** Rounding of intermediate float math differs by ≤ 2 LSB between CPU (f64) and GPU (f32). */
export const TOLERANCE = 2

declare global {
  interface Window {
    __rfGpuCheck?: Promise<GpuCheckResult[]>
  }
}

// 9:16 so a 'cover' layer maps source texels 1:1 onto target pixels
const W = 72
const H = 128

type Pixel = (x: number, y: number, c: number) => number

function makeImage(
  f: (x: number, y: number, i: number) => readonly [number, number, number],
): ImageData {
  const img = new ImageData(W, H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const [r, g, b] = f(x, y, i)
      img.data.set([r, g, b, 255], i * 4)
    }
  }
  return img
}

const at =
  (img: ImageData): Pixel =>
  (x, y, c) =>
    img.data[(y * W + x) * 4 + c]!

const u8 = (v: number): number => Math.round(Math.min(255, Math.max(0, v)))

const A = makeImage((x, y) => [
  u8((x * 255) / (W - 1)),
  u8((y * 255) / (H - 1)),
  u8(128 + 100 * Math.sin(x / 3 + y / 5)),
])
const B = makeImage((x, y) => [
  u8(128 + 120 * Math.sin(x / 5) * Math.cos(y / 7)),
  (x * 7 + y * 3) % 256,
  u8(255 - y * 2),
])
/** Deterministic pseudo-random colours spread over the whole RGB cube (colour pipeline). */
const C = makeImage((_x, _y, i) => {
  let s = (i * 2654435761) >>> 0
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s >>> 24
  }
  return [next(), next(), next()]
})
/** Green screen with a moving subject: blocks of key colour, near-key and foreground. */
const K = makeImage((x, y) => {
  const cell = ((x >> 3) + (y >> 3)) % 3
  if (cell === 0) return [u8(20 + x), 255 - (y % 40), u8(10 + y / 4)]
  if (cell === 1) return [u8(60 + y), 200, 60]
  return [u8(200 - x), u8(80 + y), u8(40 + x * 2)]
})

function compare(out: ImageData, ref: Pixel, name: string): GpuCheckResult {
  let maxErr = 0
  let bad = 0
  let n = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        const e = Math.abs(out.data[(y * W + x) * 4 + c]! - u8(ref(x, y, c)))
        if (e > maxErr) maxErr = e
        if (e > TOLERANCE) bad++
        n++
      }
    }
  }
  return { name, maxErr, badFrac: bad / n, samples: n }
}

function run(): GpuCheckResult[] {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
  })
  if (!gl) throw new Error('WebGL2 unavailable')
  const comp = new Compositor(gl)
  const clip = MediaClip.parse({
    id: 'c',
    type: 'video',
    assetId: 'x',
    start: 0,
    duration: 1e6,
    fit: 'cover',
  })
  const draw = (img: ImageData, key: string): LayerDraw => {
    const d = createLayerDraw()
    d.key = key
    d.image = img
    d.version = 1
    computeLayer(clip, 0, { width: W, height: H, rotation: 0 }, {}, d.layer)
    return d
  }
  const dA = draw(A, 'A')
  const dB = draw(B, 'B')
  const dC = draw(C, 'C')
  const dK = draw(K, 'K')
  const results: GpuCheckResult[] = []
  const frame = (paint: () => void): ImageData => {
    comp.begin(W, H)
    comp.clear('acc', 0, 0, 0)
    paint()
    return comp.readPixels()
  }

  // identity: the layer pass alone must reproduce the source exactly
  results.push(
    compare(
      frame(() => comp.layer('acc', dA)),
      at(A),
      'identity',
    ),
  )

  // transitions (xfade progress runs 1 → 0)
  const I: TransitionInputs = { w: W, h: H, max: 255, a: at(A), b: at(B) }
  for (const type of TransitionType.options) {
    for (const p of [0.9, 0.7, 0.5, 0.3, 0.1]) {
      const out = frame(() => {
        comp.clear('a', 0, 0, 0)
        comp.clear('b', 0, 0, 0)
        comp.layer('a', dA)
        comp.layer('b', dB)
        comp.transition(TRANSITION_ID[type], p)
      })
      // the shader sees progress as an f32 uniform; the GPU hblur is a fixed-tap
      // approximation of xfade's running box (compared with xfade in transitions.test.ts)
      const pf = Math.fround(p)
      const ref: Pixel =
        type === 'hblur'
          ? (x, y, c) => hblurApprox(I, x, y, c, pf)
          : (x, y, c) => transitionRef(type, I, x, y, c, pf)
      results.push(compare(out, ref, `transition:${type}@${p}`))
    }
  }

  // colour adjustments (per-pixel part of the pipeline)
  const adjustCases: Record<string, Partial<Adjustments>> = {
    contrast: { contrast: 45 },
    brightness: { brightness: -35 },
    saturation: { saturation: 70 },
    desaturate: { saturation: -80 },
    exposure: { exposure: 30 },
    warm: { temperature: 60 },
    cool: { temperature: -70 },
    tint: { tint: 50 },
    green: { tint: -50 },
    tonal: { shadows: 35, highlights: -40 },
    vibrance: { vibrance: 60 },
    devibrance: { vibrance: -60 },
    combined: {
      contrast: 20,
      saturation: 25,
      temperature: 30,
      shadows: -20,
      highlights: 25,
      vibrance: 30,
    },
  }
  for (const [name, a] of Object.entries(adjustCases)) {
    const adj = Adjustments.parse(a)
    const u = adjustUniforms(adj)
    dC.adjOn = u.on
    dC.adj.set(u.adj)
    dC.curves = u.curves
    const out = frame(() => comp.layer('acc', dC))
    const params = adjustParams(adj)
    const src = at(C)
    const cache = new Map<number, number[]>()
    const ref: Pixel = (x, y, c) => {
      const k = y * W + x
      let rgb = cache.get(k)
      if (!rgb) {
        rgb = applyAdjustmentsCpu(
          [src(x, y, 0) / 255, src(x, y, 1) / 255, src(x, y, 2) / 255],
          params,
        )
        cache.set(k, rgb)
      }
      return rgb[c]! * 255
    }
    results.push(compare(out, ref, `adjust:${name}`))
  }
  dC.adjOn = false
  return results.concat(blendChecks(comp, frame, dA, dB), keyCheck(frame, comp, dK))
}

function blendChecks(
  comp: Compositor,
  frame: (paint: () => void) => ImageData,
  dA: LayerDraw,
  dB: LayerDraw,
): GpuCheckResult[] {
  const out: GpuCheckResult[] = []
  const a = at(A)
  const b = at(B)
  for (const mode of Object.keys(BLEND_ID) as BlendMode[]) {
    dB.blend = BLEND_ID[mode]
    dB.layer.opacity = 0.7
    const img = frame(() => {
      comp.layer('acc', dA)
      comp.layer('acc', dB)
    })
    const ref: Pixel = (x, y, c) =>
      255 * compositeChannel(mode, a(x, y, c) / 255, b(x, y, c) / 255, 0.7)
    out.push(compare(img, ref, `blend:${mode}`))
  }
  dB.blend = 0
  dB.layer.opacity = 1
  return out
}

function keyCheck(
  frame: (paint: () => void) => ImageData,
  comp: Compositor,
  dK: LayerDraw,
): GpuCheckResult {
  const key = ChromaKey.parse({ enabled: true, color: '#00ff00', similarity: 0.25, blend: 0.15 })
  dK.keyOn = true
  dK.keyParams.set(chromaKeyUniforms(key))
  const img = frame(() => comp.layer('acc', dK))
  dK.keyOn = false
  const k = at(K)
  const kuv = keyUV(key.color)
  // chroma of the unrounded RGB, exactly like the shader's chromaUV()
  const chroma = (x: number, y: number): [number, number] => {
    const xx = Math.min(W - 1, Math.max(0, x))
    const yy = Math.min(H - 1, Math.max(0, y))
    const r = k(xx, yy, 0) / 255
    const g = k(xx, yy, 1) / 255
    const b = k(xx, yy, 2) / 255
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return [128 + (224 * (b - l)) / 1.8556, 128 + (224 * (r - l)) / 1.5748]
  }
  const us: number[] = []
  const vs: number[] = []
  const ref: Pixel = (x, y, c) => {
    us.length = 0
    vs.length = 0
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const [u, v] = chroma(x + 2 * i, y + 2 * j)
        us.push(u)
        vs.push(v)
      }
    }
    return k(x, y, c) * chromaKeyAlpha(us, vs, kuv, key.similarity, key.blend)
  }
  return compare(img, ref, 'chromakey')
}

async function lutCheck(): Promise<GpuCheckResult> {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('WebGL2 unavailable')
  const comp = new Compositor(gl)
  const text = warmCube(17)
  const store = new LutStore(
    gl,
    () => 'warm.cube',
    undefined,
    () => Promise.resolve(text),
  )
  const loaded = new Promise<void>((resolve) => (store.onLoad = resolve))
  store.get('dev/warm')
  await loaded
  const lut = store.get('dev/warm')
  if (!lut) throw new Error('LUT failed to load')
  const d = createLayerDraw()
  d.key = 'C'
  d.image = C
  d.version = 1
  computeLayer(
    MediaClip.parse({ id: 'c', type: 'video', assetId: 'x', start: 0, duration: 1e6 }),
    0,
    { width: W, height: H, rotation: 0 },
    {},
    d.layer,
  )
  d.lut = lut
  d.lutMix = 0.75
  comp.begin(W, H)
  comp.clear('acc', 0, 0, 0)
  comp.layer('acc', d)
  const out = comp.readPixels()
  const cube = parseCube(text)
  const tmp = new Float32Array(3)
  const c = at(C)
  const ref: Pixel = (x, y, ch) => {
    const r = c(x, y, 0) / 255
    const g = c(x, y, 1) / 255
    const b = c(x, y, 2) / 255
    sampleTetrahedral(cube, r, g, b, tmp)
    const v = [r, g, b][ch]!
    return 255 * (v + (tmp[ch]! - v) * 0.75)
  }
  const result = compare(out, ref, 'lut3d')
  comp.dispose()
  store.clear()
  return result
}

async function main(): Promise<GpuCheckResult[]> {
  const results = [...run(), await lutCheck()]
  const el = document.querySelector('#out')
  if (el) {
    el.innerHTML = results
      .map((r) => {
        const line = `${r.name.padEnd(28)} max ${String(r.maxErr).padStart(3)}  >${TOLERANCE}: ${(r.badFrac * 100).toFixed(2)}%`
        return r.badFrac > 0.01 ? `<span class="fail">${line}</span>` : line
      })
      .join('\n')
  }
  return results
}

window.__rfGpuCheck = main()
