/**
 * Text + captions overlay: libass compiled to WASM (JASSUB) renders the SAME .ass document
 * the export burns in, on its own worker into an OffscreenCanvas stacked over the WebGL
 * canvas. The browser compositor blends the two layers, so text costs the WebGL frame
 * nothing and a busy text frame never stalls video.
 *
 * Timing: the engine calls {@link TextLayer.render} with the engine clock every frame; JASSUB
 * drops renders while its worker is busy and always renders the latest requested time.
 */
import JASSUB from 'jassub'
import { assFontFamilies, fontUrlsToLoad, type FontFile } from './fonts.ts'

export interface TextLayerOptions {
  fonts: readonly FontFile[]
  /** Override JASSUB asset URLs (bundlers that cannot resolve `new URL(…, import.meta.url)`). */
  workerUrl?: string | undefined
  wasmUrl?: string | undefined
  modernWasmUrl?: string | undefined
}

/** ASS PlayRes — the 1080×1920 canvas. */
const PLAY_W = 1080
const PLAY_H = 1920

export class TextLayer {
  readonly canvas: HTMLCanvasElement
  readonly #host: HTMLCanvasElement
  readonly #jassub: JASSUB
  readonly #fonts: readonly FontFile[]
  readonly #loaded = new Set<string>()
  readonly #ro: ResizeObserver
  #ready = false
  #content = ''
  #lastT = -1
  #gen = 0
  #destroyed = false

  constructor(host: HTMLCanvasElement, opts: TextLayerOptions) {
    this.#host = host
    this.#fonts = opts.fonts
    const c = document.createElement('canvas')
    c.className = 'rf-preview-text'
    c.style.position = 'absolute'
    c.style.pointerEvents = 'none'
    c.setAttribute('aria-hidden', 'true')
    const parent = host.parentElement
    if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
    host.insertAdjacentElement('afterend', c)
    this.canvas = c
    this.#place()
    this.#ro = new ResizeObserver(() => this.#place())
    this.#ro.observe(host)
    const availableFonts: Record<string, string> = {}
    for (const f of opts.fonts) availableFonts[f.family.toLowerCase()] ??= f.url
    this.#jassub = new JASSUB({
      canvas: c,
      subContent: '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n',
      availableFonts,
      queryFonts: false,
      // the preview canvas is at most 1080×1920 device px; do not prescale beyond it
      prescaleHeightLimit: PLAY_H,
      maxRenderHeight: PLAY_H,
      ...(opts.workerUrl ? { workerUrl: opts.workerUrl } : {}),
      ...(opts.wasmUrl ? { wasmUrl: opts.wasmUrl } : {}),
      ...(opts.modernWasmUrl ? { modernWasmUrl: opts.modernWasmUrl } : {}),
    })
    void this.#jassub.ready.then(() => {
      this.#ready = true
      if (this.#content) void this.#apply(this.#content)
    })
  }

  /** Position the overlay over the 9:16 picture inside the host canvas' box. */
  #place(): void {
    const h = this.#host
    const w = h.clientWidth
    const ht = h.clientHeight
    const fitW = Math.min(w, (ht * PLAY_W) / PLAY_H)
    const fitH = (fitW * PLAY_H) / PLAY_W
    const s = this.canvas.style
    s.left = `${h.offsetLeft + (w - fitW) / 2}px`
    s.top = `${h.offsetTop + (ht - fitH) / 2}px`
    s.width = `${fitW}px`
    s.height = `${fitH}px`
  }

  /** Replace the subtitle track (call debounced; generation is cheap, upload is not free). */
  setContent(ass: string): void {
    if (ass === this.#content) return
    this.#content = ass
    if (this.#ready) void this.#apply(ass)
  }

  async #apply(ass: string): Promise<void> {
    const gen = ++this.#gen
    const urls = fontUrlsToLoad(assFontFamilies(ass), this.#fonts, this.#loaded)
    if (urls.length > 0) {
      for (const u of urls) this.#loaded.add(u)
      await this.#jassub.renderer.addFonts(urls)
    }
    if (gen !== this.#gen || this.#destroyed) return
    await this.#jassub.renderer.setTrack(ass)
    if (this.#lastT >= 0) this.render(this.#lastT, true)
  }

  /** Render the text at timeline time `t` (us). */
  render(t: number, force = false): void {
    if (!this.#ready || this.#destroyed || (!force && t === this.#lastT)) return
    this.#lastT = t
    void this.#jassub.manualRender(
      { mediaTime: t / 1e6, expectedDisplayTime: performance.now(), width: PLAY_W, height: PLAY_H },
      force,
    )
  }

  /** The rendered text at time t as RGBA (for snapshots), or undefined if unavailable. */
  async capture(
    t: number,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number } | undefined> {
    if (!this.#ready || this.#destroyed) return undefined
    const r = await this.#jassub.renderer._drawCapture(t / 1e6)
    return r ? { data: new Uint8ClampedArray(r.data), width: r.width, height: r.height } : undefined
  }

  set hidden(v: boolean) {
    this.canvas.hidden = v
  }

  destroy(): void {
    this.#destroyed = true
    this.#ro.disconnect()
    void this.#jassub.destroy()
    this.canvas.remove()
  }
}
