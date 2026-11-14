/**
 * 3D LUT textures for pack filters: fetched lazily by ref, parsed (color/cube.ts), uploaded
 * as RGB32F TEXTURE_3D (sampled with texelFetch — tetrahedral interpolation happens in the
 * shader, so no float-filtering extension is needed) and kept in a small LRU.
 */
import { parseCube, type CubeLut } from '../color/cube.ts'
import { LruCache } from '../lru.ts'

export interface LutTexture {
  tex: WebGLTexture
  size: number
  domainMin: readonly [number, number, number]
  domainScale: readonly [number, number, number]
}

type State = { ok: LutTexture } | { pending: true } | { failed: true }

export class LutStore {
  readonly #gl: WebGL2RenderingContext
  readonly #resolve: (ref: string) => string | undefined
  readonly #cache: LruCache<string, State>
  readonly #fetch: (url: string) => Promise<string>
  /** Called when a LUT finished loading (the engine redraws a paused frame). */
  onLoad: (() => void) | undefined

  constructor(
    gl: WebGL2RenderingContext,
    resolve: (ref: string) => string | undefined,
    maxBytes = 48 * 1024 * 1024,
    fetchText: (url: string) => Promise<string> = async (url) => {
      const r = await fetch(url, { credentials: 'include' })
      if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`)
      return r.text()
    },
  ) {
    this.#gl = gl
    this.#resolve = resolve
    this.#fetch = fetchText
    this.#cache = new LruCache(maxBytes, (_k, s) => {
      if ('ok' in s) gl.deleteTexture(s.ok.tex)
    })
  }

  /** The texture for `ref`, or undefined while loading / when unavailable. */
  get(ref: string): LutTexture | undefined {
    const s = this.#cache.get(ref)
    if (s) return 'ok' in s ? s.ok : undefined
    const url = this.#resolve(ref)
    if (!url) {
      this.#cache.set(ref, { failed: true }, 1)
      return undefined
    }
    this.#cache.set(ref, { pending: true }, 1)
    this.#fetch(url)
      .then((text) => {
        const lut = parseCube(text)
        if (this.#cache.peek(ref) === undefined) return // evicted / store cleared meanwhile
        const tex = this.#upload(lut)
        this.#cache.set(ref, { ok: tex }, lut.data.byteLength)
        this.onLoad?.()
      })
      .catch(() => this.#cache.set(ref, { failed: true }, 1))
    return undefined
  }

  /** True while `ref` is being fetched/parsed (a frame using it is not final yet). */
  pending(ref: string): boolean {
    const s = this.#cache.peek(ref)
    return s !== undefined && 'pending' in s
  }

  #upload(lut: CubeLut): LutTexture {
    const gl = this.#gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    const N = lut.size
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, N, N, N, 0, gl.RGB, gl.FLOAT, lut.data)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    const scale = (k: number): number => 1 / (lut.domainMax[k]! - lut.domainMin[k]!)
    return { tex, size: N, domainMin: lut.domainMin, domainScale: [scale(0), scale(1), scale(2)] }
  }

  /** Drop everything (context loss: textures are gone anyway). */
  clear(): void {
    this.#cache.clear()
  }
}
