/**
 * WebGL2 compositor. The engine describes a frame with a few calls —
 * `begin` → (`clear` / `layer` into 'acc' | 'a' | 'b') → optional `transition` (a, b → acc)
 * → `present` — and the compositor owns every GL object: programs, render targets, source
 * textures (re-uploaded only when a source's frame version changes), blur pools and LUTs.
 *
 * Per-frame work allocates nothing: uniforms come from caller-owned typed arrays and all
 * targets are pooled by size.
 */
import { ADJ_FLOATS } from '../color/adjustments.ts'
import { createLayerState, type LayerState } from '../timeline/layers.ts'
import { DualKawase, kawasePlan } from './blur.ts'
import {
  bindTarget,
  createProgram,
  createQuad,
  createTarget,
  createTexture,
  deleteTarget,
  type Program,
  type Target,
} from './context.ts'
import type { LutTexture } from './lut.ts'
import {
  COPY_FS,
  FULLSCREEN_VS,
  KAWASE_DOWN_FS,
  KAWASE_UP_FS,
  LAYER_FS,
  LAYER_VS,
} from './shaders.ts'
import { dissolveNoise, TRANSITION_GLSL, TRANSITION_ID } from './transitions.ts'

/** Everything needed to draw one layer. Engine-owned and reused every frame. */
export interface LayerDraw {
  /** Pool key of the pixel source (texture cache key). */
  key: string
  image: TexImageSource | null
  version: number
  readonly layer: LayerState
  adjOn: boolean
  /** sharpen, vignette angle, grain, curves-on (color/adjustments.ts packAdjustUniforms). */
  readonly adj: Float32Array
  /** 256×1 RGBA8 Y/U/V curve table, uploaded only when it changes between draws. */
  curves: Uint8Array | null
  /** Adjustment Gaussian blur σ in canvas px. */
  blurPx: number
  lut: LutTexture | undefined
  lutMix: number
  keyOn: boolean
  /** key U, key V, similarity, blend */
  readonly keyParams: Float32Array
  /** BLEND_ID */
  blend: number
  /** Temporal noise seed (changes per frame). */
  seed: number
  /** AI background (BG_MODE); 0 = off. Needs `matte`. */
  bgMode: number
  /** Subject matte frame (pool key, image, version). */
  readonly matte: TextureRef
  /** Background image (`image` mode). */
  readonly bgImage: TextureRef
  /** Colour mode: linear 0..1 RGB. */
  readonly bgColor: Float32Array
  /** Blur mode σ in canvas px. */
  bgBlurPx: number
  /** Matte feather σ in canvas px. */
  featherPx: number
  /** Image mode: cover rect of the layer quad in image UV (u0, v0, u1, v1). */
  readonly bgUV: Float32Array
}

/** A texture-able image with a cache key and a version (re-upload when either changes). */
export interface TextureRef {
  key: string
  image: TexImageSource | null
  version: number
}

/** `LayerDraw.bgMode` values (uBgMode in the layer shader). */
export const BG_MODE = { off: 0, remove: 1, blur: 2, color: 3, image: 4 } as const

export function createLayerDraw(): LayerDraw {
  return {
    key: '',
    image: null,
    version: -1,
    layer: createLayerState(),
    adjOn: false,
    adj: new Float32Array(ADJ_FLOATS),
    curves: null,
    blurPx: 0,
    lut: undefined,
    lutMix: 0,
    keyOn: false,
    keyParams: new Float32Array(4),
    blend: 0,
    seed: 0,
    bgMode: 0,
    matte: { key: '', image: null, version: -1 },
    bgImage: { key: '', image: null, version: -1 },
    bgColor: new Float32Array(3),
    bgBlurPx: 0,
    featherPx: 0,
    bgUV: new Float32Array([0, 0, 1, 1]),
  }
}

interface SourceTexture {
  tex: WebGLTexture
  image: TexImageSource | null
  version: number
  width: number
  height: number
  /** Frame number when last used (sweeping). */
  used: number
}

export type TargetName = 'acc' | 'a' | 'b'

/** Natural pixel size of any TexImageSource. */
function imageSize(img: TexImageSource): [number, number] {
  if (typeof VideoFrame !== 'undefined' && img instanceof VideoFrame)
    return [img.displayWidth, img.displayHeight]
  if (typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement)
    return [img.videoWidth, img.videoHeight]
  const s = img as { width: number; height: number }
  return [s.width, s.height]
}

export interface CompositorStats {
  uploads: number
  draws: number
  blurPasses: number
}

export class Compositor {
  readonly gl: WebGL2RenderingContext
  readonly #layer: Program
  readonly #copy: Program
  readonly #trans: Program
  readonly #quad: WebGLVertexArrayObject
  readonly #blur: DualKawase
  readonly #sources = new Map<string, SourceTexture>()
  readonly #targets: Record<TargetName | 'dst', Target | null> = {
    acc: null,
    a: null,
    b: null,
    dst: null,
  }
  /** 1×1 placeholders so unused samplers are always complete. */
  readonly #dummy2d: WebGLTexture
  readonly #dummy3d: WebGLTexture
  /** 256×1 Y/U/V adjustment curve table, permanently bound to texture unit 4. */
  readonly #curves: WebGLTexture
  #curvesData: Uint8Array | null = null
  /** xfade dissolve hash table at the current target size (created on first dissolve). */
  #noise: WebGLTexture | null = null
  #w = 0
  #h = 0
  #frame = 0
  #blurSlot = 0
  readonly stats: CompositorStats = { uploads: 0, draws: 0, blurPasses: 0 }

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.#quad = createQuad(gl)
    this.#layer = createProgram(gl, LAYER_VS, LAYER_FS)
    this.#copy = createProgram(gl, FULLSCREEN_VS, COPY_FS)
    this.#trans = createProgram(gl, FULLSCREEN_VS, TRANSITION_GLSL)
    this.#blur = new DualKawase(
      gl,
      createProgram(gl, FULLSCREEN_VS, KAWASE_DOWN_FS),
      createProgram(gl, FULLSCREEN_VS, KAWASE_UP_FS),
      this.#quad,
    )
    this.#dummy2d = createTexture(gl)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    this.#dummy3d = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_3D, this.#dummy3d)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, 1, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array(3))
    this.#curves = createTexture(gl, gl.NEAREST)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 1)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, this.#curves)
    gl.activeTexture(gl.TEXTURE0)
    // FFmpeg applies no colour-management to decoded pixels; neither do we
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    // static sampler bindings
    gl.useProgram(this.#layer.program)
    gl.uniform1i(this.#layer.u('uTex'), 0)
    gl.uniform1i(this.#layer.u('uGlow'), 1)
    gl.uniform1i(this.#layer.u('uDst'), 2)
    gl.uniform1i(this.#layer.u('uLut'), 3)
    gl.uniform1i(this.#layer.u('uCurves'), 4)
    gl.uniform1i(this.#layer.u('uMatte'), 5)
    gl.uniform1i(this.#layer.u('uBg'), 6)
    gl.useProgram(this.#trans.program)
    gl.uniform1i(this.#trans.u('uA'), 0)
    gl.uniform1i(this.#trans.u('uB'), 1)
    gl.uniform1i(this.#trans.u('uNoise'), 2)
    gl.useProgram(this.#copy.program)
    gl.uniform1i(this.#copy.u('uSrc'), 0)
  }

  get width(): number {
    return this.#w
  }

  get height(): number {
    return this.#h
  }

  /** Start a frame at `w`×`h` target pixels (targets are re-created only on size change). */
  begin(w: number, h: number): void {
    const gl = this.gl
    if (w !== this.#w || h !== this.#h) {
      for (const k of ['acc', 'a', 'b', 'dst'] as const) {
        const t = this.#targets[k]
        if (t) deleteTarget(gl, t)
        this.#targets[k] = null
      }
      if (this.#noise) gl.deleteTexture(this.#noise)
      this.#noise = null
      this.#w = w
      this.#h = h
    }
    this.#frame++
    this.#blurSlot = 0
    this.stats.uploads = 0
    this.stats.draws = 0
    this.stats.blurPasses = 0
  }

  #target(name: TargetName | 'dst'): Target {
    let t = this.#targets[name]
    if (!t) {
      t = createTarget(this.gl, this.#w, this.#h)
      this.#targets[name] = t
    }
    return t
  }

  clear(name: TargetName, r: number, g: number, b: number): void {
    const gl = this.gl
    bindTarget(gl, this.#target(name), 0, 0)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Upload (if changed) and return the texture for a layer's source. */
  #sourceTexture(d: TextureRef): SourceTexture | undefined {
    if (!d.image) return undefined
    const gl = this.gl
    let s = this.#sources.get(d.key)
    if (!s) {
      s = { tex: createTexture(gl), image: null, version: -1, width: 0, height: 0, used: 0 }
      this.#sources.set(d.key, s)
    }
    s.used = this.#frame
    if (s.image !== d.image || s.version !== d.version) {
      const [w, h] = imageSize(d.image)
      if (w === 0 || h === 0) return undefined
      gl.bindTexture(gl.TEXTURE_2D, s.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, d.image)
      s.image = d.image
      s.version = d.version
      s.width = w
      s.height = h
      this.stats.uploads++
    }
    return s
  }

  /** Draw one layer into `name`. */
  layer(name: TargetName, d: LayerDraw): void {
    const src = this.#sourceTexture(d)
    if (!src || d.layer.opacity <= 0) return
    const gl = this.gl
    const L = d.layer
    const fx = L.fx
    const minSide = Math.min(src.width, src.height)
    let tex = src.tex
    const blurPx = Math.hypot(d.blurPx, fx.blur)
    const blurPlan = blurPx > 0 ? kawasePlan(blurPx * L.texelsPerPx, minSide) : null
    if (blurPlan) {
      tex = this.#blur.run(src.tex, src.width, src.height, blurPlan, this.#blurSlot++)
      this.stats.blurPasses += blurPlan.levels * 2
    }
    let glow: WebGLTexture = this.#dummy2d
    const glowPlan = fx.glowStrength > 0 ? kawasePlan(fx.glowSigma * L.texelsPerPx, minSide) : null
    if (glowPlan) {
      glow = this.#blur.run(src.tex, src.width, src.height, glowPlan, this.#blurSlot++)
      this.stats.blurPasses += glowPlan.levels * 2
    }
    // blurs and texture uploads draw into pooled targets: do them before this layer's own
    // target and program are bound
    const bgp = this.#prepareBackground(d, src)
    const target = this.#target(name)
    if (d.blend !== 0) {
      // non-separable-from-GL blend: read the destination from a copy of the target
      const dst = this.#target('dst')
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.fbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo)
      gl.blitFramebuffer(
        0,
        0,
        this.#w,
        this.#h,
        0,
        0,
        this.#w,
        this.#h,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      )
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, dst.tex)
      gl.disable(gl.BLEND)
    } else {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    }
    bindTarget(gl, target, 0, 0)
    const P = this.#layer
    gl.useProgram(P.program)
    gl.bindVertexArray(this.#quad)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, glow)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_3D, d.lut ? d.lut.tex : this.#dummy3d)
    if (d.blend === 0) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this.#dummy2d)
    }
    const m = L.m
    gl.uniform2f(P.u('uM0'), m[0]!, m[1]!)
    gl.uniform2f(P.u('uM1'), m[2]!, m[3]!)
    gl.uniform2f(P.u('uM2'), m[4]!, m[5]!)
    gl.uniform2f(P.u('uTexel'), 1 / src.width, 1 / src.height)
    gl.uniform4fv(P.u('uUV'), L.uv)
    gl.uniform1i(P.u('uRot'), L.rotation)
    gl.uniform1f(P.u('uOpacity'), L.opacity)
    gl.uniform2f(P.u('uLayerSize'), L.width, L.height)
    gl.uniform1i(P.u('uAdjOn'), d.adjOn ? 1 : 0)
    gl.uniform4fv(P.u('uAdj'), d.adj)
    if (d.adjOn && d.curves) this.#uploadCurves(d.curves)
    const lut = d.lut
    gl.uniform1f(P.u('uLutMix'), lut ? d.lutMix : 0)
    if (lut) {
      gl.uniform1f(P.u('uLutN'), lut.size)
      gl.uniform3f(P.u('uLutMin'), lut.domainMin[0], lut.domainMin[1], lut.domainMin[2])
      gl.uniform3f(P.u('uLutScale'), lut.domainScale[0], lut.domainScale[1], lut.domainScale[2])
    }
    gl.uniform1i(P.u('uKeyOn'), d.keyOn ? 1 : 0)
    gl.uniform4fv(P.u('uKey'), d.keyParams)
    const scale = this.#h / 1920
    gl.uniform4f(
      P.u('uFx0'),
      L.width > 0 ? fx.rgbSplit / L.width : 0,
      fx.white,
      fx.desaturate,
      fx.scanlines,
    )
    const noise = (d.adjOn ? d.adj[2]! / 255 : 0) + fx.grain + fx.noise
    gl.uniform4f(P.u('uFx1'), noise, d.seed, glowPlan ? fx.glowStrength : 0, Math.max(2, 4 * scale))
    gl.uniform1i(P.u('uBlend'), d.blend)
    this.#bindBackground(bgp, d, src, P)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    this.stats.draws++
  }

  /** Textures an AI background needs, resolved before the layer's target is bound. */
  #prepareBackground(
    d: LayerDraw,
    src: SourceTexture,
  ): { mode: number; matte: SourceTexture | undefined; bg: WebGLTexture } {
    const matte = d.bgMode !== 0 ? this.#sourceTexture(d.matte) : undefined
    let bg: WebGLTexture = this.#dummy2d
    let mode = matte ? d.bgMode : 0
    if (mode === 2) {
      const plan = kawasePlan(d.bgBlurPx * d.layer.texelsPerPx, Math.min(src.width, src.height))
      bg = plan ? this.#blur.run(src.tex, src.width, src.height, plan, this.#blurSlot++) : src.tex
      if (plan) this.stats.blurPasses += plan.levels * 2
    } else if (mode === 4) {
      const img = this.#sourceTexture(d.bgImage)
      if (img) bg = img.tex
      else mode = 3 // image still loading: show the colour meanwhile
    }
    return { mode, matte, bg }
  }

  /** AI background uniforms + textures (units 5 and 6); off when the matte is missing. */
  #bindBackground(
    prepared: { mode: number; matte: SourceTexture | undefined; bg: WebGLTexture },
    d: LayerDraw,
    src: SourceTexture,
    P: Program,
  ): void {
    const gl = this.gl
    const { mode, matte, bg } = prepared
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(gl.TEXTURE_2D, matte ? matte.tex : this.#dummy2d)
    gl.activeTexture(gl.TEXTURE6)
    gl.bindTexture(gl.TEXTURE_2D, bg)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(P.u('uBgMode'), mode)
    if (!matte) return
    gl.uniform2f(P.u('uMatteTexel'), 1 / matte.width, 1 / matte.height)
    // canvas px → matte texels (the matte spans the same picture as the source texture)
    const k =
      d.layer.texelsPerPx * (Math.min(matte.width, matte.height) / Math.min(src.width, src.height))
    gl.uniform1f(P.u('uFeather'), d.featherPx * k)
    gl.uniform3fv(P.u('uBgColor'), d.bgColor)
    gl.uniform4fv(P.u('uBgUV'), d.bgUV)
  }

  /** Upload a curve table unless it is the one already on unit 4 (tables are cached per edit). */
  #uploadCurves(data: Uint8Array): void {
    if (data === this.#curvesData) return
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE4)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.activeTexture(gl.TEXTURE0)
    this.#curvesData = data
  }

  /**
   * Mix targets 'a' (outgoing) and 'b' (incoming) into 'acc' with transition `typeId` at
   * xfade progress `progress` (1 = all A → 0 = all B).
   */
  transition(typeId: number, progress: number): void {
    const gl = this.gl
    const a = this.#target('a')
    const b = this.#target('b')
    bindTarget(gl, this.#target('acc'), 0, 0)
    gl.disable(gl.BLEND)
    const P = this.#trans
    gl.useProgram(P.program)
    gl.bindVertexArray(this.#quad)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, a.tex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, b.tex)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(
      gl.TEXTURE_2D,
      typeId === TRANSITION_ID.dissolve ? this.#noiseTexture() : this.#dummy2d,
    )
    gl.uniform1i(P.u('uType'), typeId)
    gl.uniform1f(P.u('uProgress'), progress)
    gl.uniform2f(P.u('uSize'), this.#w, this.#h)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    this.stats.draws++
  }

  /** The dissolve hash table for the current size (≈ 10 ms of CPU once per size at 540p). */
  #noiseTexture(): WebGLTexture {
    if (this.#noise) return this.#noise
    const gl = this.gl
    // R32F is not filterable without an extension: NEAREST + texelFetch
    const tex = createTexture(gl, gl.NEAREST)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      this.#w,
      this.#h,
      0,
      gl.RED,
      gl.FLOAT,
      dissolveNoise(this.#w, this.#h),
    )
    this.#noise = tex
    return tex
  }

  /** Copy 'acc' to the canvas (whose backing store must be width×height). */
  present(): void {
    const gl = this.gl
    bindTarget(gl, null, this.#w, this.#h)
    gl.disable(gl.BLEND)
    gl.useProgram(this.#copy.program)
    gl.bindVertexArray(this.#quad)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#target('acc').tex)
    gl.uniform1i(this.#copy.u('uFlip'), 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    this.stats.draws++
  }

  /** Read 'acc' as top-down RGBA rows (snapshot). */
  readPixels(): ImageData {
    const gl = this.gl
    const w = this.#w
    const h = this.#h
    const buf = new Uint8ClampedArray(w * h * 4)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.#target('acc').fbo)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    // GL rows are bottom-up
    const row = w * 4
    const tmp = new Uint8ClampedArray(row)
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row
      const b = (h - 1 - y) * row
      tmp.set(buf.subarray(a, a + row))
      buf.copyWithin(a, b, b + row)
      buf.set(tmp, b)
    }
    return new ImageData(buf, w, h)
  }

  /** Delete source textures not used for `frames` frames, and idle blur pools. */
  sweep(frames = 120): void {
    for (const [k, s] of this.#sources) {
      if (this.#frame - s.used > frames) {
        this.gl.deleteTexture(s.tex)
        this.#sources.delete(k)
      }
    }
    this.#blur.trim(5000)
  }

  /** Approximate GPU bytes held by source textures and targets (stats). */
  get gpuBytes(): number {
    let n = 0
    for (const s of this.#sources.values()) n += s.width * s.height * 4
    for (const t of Object.values(this.#targets)) if (t) n += t.width * t.height * 4
    if (this.#noise) n += this.#w * this.#h * 4
    return n
  }

  dispose(): void {
    const gl = this.gl
    for (const s of this.#sources.values()) gl.deleteTexture(s.tex)
    this.#sources.clear()
    for (const t of Object.values(this.#targets)) if (t) deleteTarget(gl, t)
    this.#blur.dispose()
    gl.deleteTexture(this.#dummy2d)
    gl.deleteTexture(this.#dummy3d)
    gl.deleteTexture(this.#curves)
    if (this.#noise) gl.deleteTexture(this.#noise)
    gl.deleteProgram(this.#layer.program)
    gl.deleteProgram(this.#copy.program)
    gl.deleteProgram(this.#trans.program)
    gl.deleteVertexArray(this.#quad)
  }
}
