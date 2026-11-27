/**
 * The preview engine: owns the frame loop and wires the timeline index, decoders, WebGL
 * compositor, libass text layer and WebAudio mix together. See README.md for the design.
 *
 * Frame loop (rAF):
 *   clock.tick (audio-mastered while playing) → TimelineIndex.resolve(t) → pool.update
 *   (visible + 1 s look-ahead) → source.want() → compose layers → present → text.render(t)
 *   → audio.schedule(t) → adaptive quality.
 * While paused the loop only runs until every visible source shows its exact frame, so an
 * idle editor costs nothing.
 */
import {
  BACKGROUND_BLUR_SIGMA,
  buildAss,
  MATTE_FEATHER_SIGMA,
  type Asset,
  type MediaClip,
  type Project,
  type Us,
} from '@reelforge/core'
import { AudioEngine } from './audio/engine.ts'
import { collectVoices } from './audio/voices.ts'
import { audioOutputTime, PlaybackClock } from './clock.ts'
import { BLEND_ID } from './color/keying.ts'
import { adjustUniforms, chromaKeyUniforms, hexToRgb } from './color/uniforms.ts'
import {
  BG_MODE,
  Compositor,
  createLayerDraw,
  type LayerDraw,
  type TargetName,
} from './gl/compositor.ts'
import { GlError } from './gl/context.ts'
import { LutStore } from './gl/lut.ts'
import { TRANSITION_ID } from './gl/transitions.ts'
import type { PreviewEngine, PreviewEngineOptions, PreviewEvent, PreviewStats } from './index.ts'
import { HttpByteSource } from './media/byteSource.ts'
import { ElementSource } from './media/element.ts'
import { ImageCache, ImageSource } from './media/image.ts'
import { MediaFiles } from './media/mediaFile.ts'
import { poolKey, SourcePool } from './media/pool.ts'
import { createMediaStats, type PixelSource } from './media/source.ts'
import { hasWebCodecs, WebCodecsSource } from './media/webcodecs.ts'
import { AdaptiveQuality, type QualityMode } from './quality.ts'
import { TextLayer } from './text/textLayer.ts'
import {
  BACKGROUND_BLUR_PX,
  computeFill,
  computeLayer,
  type LayerContext,
  type SourceInfo as LayerSource,
} from './timeline/layers.ts'
import { createFramePlan, TimelineIndex, type Slot, type VisualClip } from './timeline/resolve.ts'
import { sourceRateAt, sourceTimeAt } from './timeline/sourceTime.ts'

/** Decode-ahead horizon while playing (us). */
const PLAY_HORIZON_US = 1_000_000
/** Look-ahead while paused: pre-roll the next clip's first frame for instant play. */
const PAUSE_HORIZON_US = 300_000
/** Consecutive starved frames before playback stalls and emits 'waiting'. */
const STALL_FRAMES = 8
/** ASS regeneration debounce (ms). */
const ASS_DEBOUNCE_MS = 50

/** Device class heuristics: phones get fewer decoders and smaller caches. */
function deviceBudget(): {
  decoders: number
  elementDecoders: number
  audioBytes: number
  imageBytes: number
} {
  const nav = globalThis.navigator as Navigator & { deviceMemory?: number }
  const mem = nav?.deviceMemory ?? 8
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const small = mem <= 4 || coarse
  return {
    decoders: small ? 4 : 8,
    elementDecoders: small ? 2 : 4,
    audioBytes: (small ? 48 : 128) * 1024 * 1024,
    imageBytes: (small ? 96 : 256) * 1024 * 1024,
  }
}

const asLayerSource = (src: PixelSource): LayerSource | undefined => src.info

class Engine implements PreviewEngine {
  readonly #canvas: HTMLCanvasElement
  readonly #opts: PreviewEngineOptions
  readonly #gl: WebGL2RenderingContext
  #comp: Compositor | undefined
  #luts: LutStore | undefined
  readonly #text: TextLayer | undefined
  readonly #audio: AudioEngine
  #overlayToken = 0
  readonly #files: MediaFiles
  readonly #images: ImageCache
  readonly #pool: SourcePool
  /** Subject mattes (AI background), one decoder per clip like `#pool`. */
  readonly #mattes: SourcePool
  /** Background images (`image` mode) by URL. */
  readonly #bgImages = new Map<string, ImageSource>()
  readonly #mediaStats = createMediaStats()
  readonly #clock = new PlaybackClock()
  readonly #quality = new AdaptiveQuality()
  readonly #listeners = new Map<PreviewEvent, Set<(t: Us) => void>>()
  readonly #useWebCodecs: boolean
  readonly #layerCtx: LayerContext
  // model
  #project: Project | undefined
  #assets: Readonly<Record<string, Asset>> = {}
  #index: TimelineIndex | undefined
  #solo = new Set<string>()
  // frame state (reused, never reallocated per frame)
  readonly #plan = createFramePlan()
  readonly #collect: Slot[] = []
  readonly #needed: VisualClip[] = []
  readonly #draws: LayerDraw[] = []
  #drawCount = 0
  readonly #fill = createLayerDraw()
  #time = 0
  #playing = false
  #waiting = false
  #starved = 0
  #raf = 0
  #lastFrameAt = 0
  #complete = false
  #dirty = true
  #lost = false
  #destroyed = false
  #assTimer: ReturnType<typeof setTimeout> | undefined
  #sourceUrls = new Map<string, string>()
  readonly stats: PreviewStats

  constructor(canvas: HTMLCanvasElement, opts: PreviewEngineOptions) {
    this.#canvas = canvas
    this.#opts = opts
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    })
    if (!gl) throw new GlError('WebGL2 is not available')
    this.#gl = gl
    canvas.style.objectFit = 'contain'
    canvas.addEventListener('webglcontextlost', this.#onLost)
    canvas.addEventListener('webglcontextrestored', this.#onRestored)
    this.#initGl()
    const budget = deviceBudget()
    const open = opts.openMedia ?? ((url: string) => new HttpByteSource(url))
    this.#files = new MediaFiles(open)
    this.#images = new ImageCache(budget.imageBytes)
    this.#useWebCodecs =
      opts.decoder === 'element' ? false : opts.decoder === 'webcodecs' || hasWebCodecs()
    this.#pool = new SourcePool(
      (clip, prev) => this.#openSource(clip, prev),
      this.#useWebCodecs ? budget.decoders : budget.elementDecoders,
    )
    // mattes are small gray proxies: half the decoder budget is plenty
    this.#mattes = new SourcePool(
      (clip, prev) => this.#openMatte(clip, prev),
      Math.max(2, (this.#useWebCodecs ? budget.decoders : budget.elementDecoders) >> 1),
    )
    this.#layerCtx = { resolveEffect: opts.resolveEffect, resolveAnimation: opts.resolveAnimation }
    this.#audio = new AudioEngine({
      files: this.#files,
      urlOf: (id) => this.#assetUrl(id),
      cacheBytes: budget.audioBytes,
    })
    this.#audio.unlock()
    this.#audio.onUnlock = () => {
      if (this.#playing && !this.#waiting) this.#startClock(this.#time)
    }
    let text: TextLayer | undefined
    try {
      text = new TextLayer(canvas, { fonts: opts.fonts, ...opts.jassub })
    } catch {
      // no Worker/WASM/OffscreenCanvas: video still previews, text is unavailable
      text = undefined
    }
    this.#text = text
    this.stats = {
      fps: 0,
      frameMs: 0,
      renderWidth: 0,
      renderHeight: 0,
      qualityLevel: 0,
      framesComposited: 0,
      inexactFrames: 0,
      frameExact: false,
      framesDecoded: 0,
      decoderResets: 0,
      activeDecoders: 0,
      bytesFetched: 0,
      textureUploads: 0,
      drawCalls: 0,
      gpuBytes: 0,
      audioDecodedBytes: 0,
      imageBytes: 0,
      waiting: false,
      decoder: this.#useWebCodecs ? 'webcodecs' : 'element',
      time: 0,
    }
    ;(globalThis as { __rfPreviewStats?: PreviewStats }).__rfPreviewStats = this.stats
  }

  #initGl(): void {
    this.#comp = new Compositor(this.#gl)
    this.#luts = new LutStore(this.#gl, (ref) => this.#opts.resolveLut?.(ref))
    this.#luts.onLoad = () => this.#invalidate()
  }

  readonly #onLost = (e: Event): void => {
    e.preventDefault() // allow restoration
    this.#lost = true
    this.#comp = undefined
    this.#luts = undefined
  }

  readonly #onRestored = (): void => {
    this.#lost = false
    this.#initGl()
    this.#invalidate()
  }

  /* ------------------------------------------------------------------ model */

  #assetUrl(assetId: string): string | undefined {
    const a = this.#assets[assetId]
    if (!a) return undefined
    return this.#opts.mediaUrl(a.id, a.proxy === 'ready' ? 'proxy' : 'original')
  }

  #clipUrl(clip: VisualClip): string | undefined {
    if (clip.type === 'sticker') {
      if (clip.assetId) return this.#assetUrl(clip.assetId)
      return clip.ref ? this.#opts.resolveSticker?.(clip.ref) : undefined
    }
    return this.#assetUrl(clip.assetId)
  }

  #openSource(clip: VisualClip, previous: PixelSource | undefined): PixelSource | null {
    const url = this.#clipUrl(clip)
    if (!url) return null
    this.#sourceUrls.set(poolKey(clip), url)
    const asset = clip.type === 'sticker' ? undefined : this.#assets[clip.assetId]
    if (clip.type !== 'video' || asset?.kind === 'image') {
      return previous ? null : new ImageSource(url, this.#images)
    }
    if (previous?.kind === 'element') return null
    if (previous || !this.#useWebCodecs) return new ElementSource(url, this.#mediaStats)
    return new WebCodecsSource(this.#files.open(url), this.#mediaStats)
  }

  /** Preview mask URL of a clip's matte when its AI background applies, else undefined. */
  #matteUrl(clip: VisualClip): string | undefined {
    if (clip.type === 'sticker' || !this.#opts.matteUrl) return undefined
    const bg = clip.background
    if (!bg || bg.mode === 'keep') return undefined
    const m = this.#assets[clip.assetId]?.matte
    if (m?.status !== 'ready') return undefined
    return this.#opts.matteUrl(clip.assetId, m.version)
  }

  #openMatte(clip: VisualClip, previous: PixelSource | undefined): PixelSource | null {
    const url = this.#matteUrl(clip)
    if (!url) return null
    const asset = clip.type === 'sticker' ? undefined : this.#assets[clip.assetId]
    if (clip.type !== 'video' || asset?.kind === 'image')
      return previous ? null : new ImageSource(url, this.#images)
    if (previous?.kind === 'element') return null
    if (previous || !this.#useWebCodecs) return new ElementSource(url, this.#mediaStats)
    return new WebCodecsSource(this.#files.open(url), this.#mediaStats)
  }

  #bgImage(assetId: string | undefined): ImageSource | undefined {
    const url = assetId ? this.#assetUrl(assetId) : undefined
    if (!url) return undefined
    let s = this.#bgImages.get(url)
    if (!s) {
      s = new ImageSource(url, this.#images)
      this.#bgImages.set(url, s)
    }
    return s
  }

  setProject(p: Project, assets: Readonly<Record<string, Asset>>): void {
    const prev = this.#project
    const assetsChanged = assets !== this.#assets
    this.#project = p
    this.#assets = assets
    const tracksChanged = !prev || prev.tracks !== p.tracks || prev.captions !== p.captions
    if (tracksChanged) this.#index = new TimelineIndex(p)
    if (tracksChanged || assetsChanged) this.#rebuildVoices()
    if (assetsChanged) {
      // a proxy finishing changes the URL a clip should decode from: reopen those sources
      const keep = new Set<string>()
      for (const [key, url] of this.#sourceUrls) {
        const assetId = key.slice(key.indexOf('|') + 1)
        const now = this.#assets[assetId] ? this.#assetUrl(assetId) : url
        if (now === url) keep.add(key)
      }
      if (keep.size !== this.#sourceUrls.size) {
        this.#pool.closeAll()
        this.#sourceUrls.clear()
      }
      // a new or rebuilt matte (version in the URL): reopen the mask decoders
      this.#mattes.closeAll()
      const urls = new Set<string>()
      for (const id of Object.keys(assets)) {
        const u = this.#assetUrl(id)
        if (u) urls.add(u)
      }
      this.#files.retain(urls)
    }
    const textChanged =
      !prev ||
      prev.captions !== p.captions ||
      prev.settings !== p.settings ||
      prev.tracks.length !== p.tracks.length ||
      p.tracks.some((t, i) => t.kind === 'text' && t !== prev.tracks[i])
    if (textChanged) this.#scheduleAss()
    if (this.#time > this.duration) this.#time = this.duration
    this.#invalidate()
  }

  #rebuildVoices(): void {
    if (!this.#project || !this.#index) return
    let voices = collectVoices(this.#project, this.#index.layout, this.#assets, {
      solo: this.#solo,
    })
    // A previewed trending sound replaces the music bed (voices and effects stay).
    if (this.#audio.hasOverlay) {
      const music = new Set<string>()
      for (const t of this.#project.tracks)
        for (const c of t.clips) if (c.type === 'audio' && c.role === 'music') music.add(c.id)
      voices = voices.filter((v) => !music.has(v.clipId))
    }
    this.#audio.setVoices(voices)
  }

  async setSoundPreview(audio: ArrayBuffer | undefined): Promise<void> {
    const token = ++this.#overlayToken
    // decodeAudioData detaches its input: decode a copy so the caller keeps the bytes.
    const buffer = audio ? await this.#audio.ctx.decodeAudioData(audio.slice(0)) : undefined
    if (token !== this.#overlayToken) return
    this.#audio.setOverlay(buffer)
    this.#rebuildVoices()
  }

  setSolo(trackIds: readonly string[]): void {
    this.#solo = new Set(trackIds)
    this.#rebuildVoices()
  }

  #scheduleAss(): void {
    if (!this.#text) return
    clearTimeout(this.#assTimer)
    this.#assTimer = setTimeout(() => {
      const p = this.#project
      if (!p || this.#destroyed) return
      try {
        const ass = buildAss(p, { resolveAnimation: (ref) => this.#opts.resolveAnimation?.(ref) })
        this.#text?.setContent(ass)
      } catch {
        // keep showing the previous text until the model is valid again
      }
    }, ASS_DEBOUNCE_MS)
  }

  get duration(): Us {
    return this.#index?.duration ?? 0
  }

  /* ------------------------------------------------------------------ transport */

  get playing(): boolean {
    return this.#playing
  }

  get time(): Us {
    return this.#time
  }

  on(event: PreviewEvent, cb: (t: Us) => void): () => void {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }

  #emit(event: PreviewEvent): void {
    const set = this.#listeners.get(event)
    if (set) for (const cb of set) cb(this.#time)
  }

  seek(t: Us): void {
    const tt = Math.max(0, Math.min(Math.round(t), this.duration))
    this.#time = tt
    this.#clock.seek(tt, performance.now())
    if (this.#playing) this.#startWhenReady()
    this.#audio.prefetch(tt)
    this.#emit('time')
    this.#invalidate()
  }

  play(): void {
    if (this.#playing) return
    if (this.#time >= this.duration) this.#time = 0
    this.#playing = true
    this.#startWhenReady()
    this.#emit('play')
    this.#invalidate()
  }

  pause(): void {
    if (!this.#playing) return
    this.#playing = false
    this.#waiting = false
    this.#time = this.#clock.stop()
    this.#audio.stop()
    this.#emit('pause')
    this.#invalidate()
  }

  /**
   * Run the clock only once the frame at the current time is composited exactly. Starting
   * while a seek is still decoding would advance time past frames that are not there yet,
   * starve for {@link STALL_FRAMES} and resume late; holding (silently — this is not a
   * 'waiting' stall) costs at most the seek latency and keeps picture and sound together.
   */
  #startWhenReady(): void {
    this.#clock.stop()
    this.#audio.stop()
    this.#waiting = true
    this.#starved = 0
  }

  #startClock(t: number): void {
    const anchor = this.#audio.play(t)
    this.#clock.start(t, performance.now(), anchor)
  }

  setQuality(q: QualityMode): void {
    this.#quality.setMode(q)
    this.#invalidate()
  }

  /* ------------------------------------------------------------------ frame loop */

  #invalidate(): void {
    this.#dirty = true
    if (!this.#raf && !this.#destroyed) this.#raf = requestAnimationFrame(this.#frame)
  }

  readonly #frame = (now: number): void => {
    this.#raf = 0
    if (this.#destroyed) return
    const dt = this.#lastFrameAt ? now - this.#lastFrameAt : 0
    this.#lastFrameAt = now
    if (this.#playing && !this.#waiting) {
      const master = this.#audio.anchor ? audioOutputTime(this.#audio.ctx, now) : undefined
      const t = this.#clock.tick(now, master)
      this.#time = Math.min(t, this.duration)
      this.#emit('time')
    }
    if (!this.#lost && this.#comp) {
      const t0 = performance.now()
      this.#render(this.#time)
      const cost = performance.now() - t0
      this.#updateStats(cost, dt)
    }
    if (this.#playing) {
      if (this.#waiting) {
        if (this.#complete) {
          this.#waiting = false
          this.stats.waiting = false
          this.#starved = 0
          this.#startClock(this.#time)
        }
      } else if (!this.#complete) {
        if (++this.#starved >= STALL_FRAMES) {
          // decoders cannot keep up (network / seek): hold picture AND sound together
          this.#waiting = true
          this.stats.waiting = true
          this.#clock.stop()
          this.#audio.stop()
          this.#emit('waiting')
        }
      } else {
        this.#starved = 0
      }
      if (this.#time >= this.duration && !this.#waiting) {
        this.#playing = false
        this.#clock.stop()
        this.#audio.stop()
        this.#emit('pause')
        this.#emit('ended')
      }
    }
    // keep looping while playing, or until the paused frame is complete
    if (this.#playing || !this.#complete || this.#dirty)
      this.#raf = requestAnimationFrame(this.#frame)
  }

  #updateStats(cost: number, dt: number): void {
    const s = this.stats
    s.frameMs = s.frameMs === 0 ? cost : s.frameMs * 0.9 + cost * 0.1
    if (dt > 0) s.fps = s.fps === 0 ? 1000 / dt : s.fps * 0.9 + (1000 / dt) * 0.1
    // the browser missing vsync while playing means the GPU is the bottleneck: count it
    const overloaded = this.#playing && dt > 1000 / 40
    if (this.#quality.record(overloaded ? Math.max(cost, 1000 / 40) : cost)) this.#dirty = true
    const m = this.#mediaStats
    s.framesDecoded = m.framesDecoded
    s.decoderResets = m.decoderResets
    s.activeDecoders = m.activeDecoders
    s.bytesFetched = m.bytesFetched
    s.qualityLevel = this.#quality.level
    s.gpuBytes = this.#comp?.gpuBytes ?? 0
    s.audioDecodedBytes = this.#audio.decodedBytes
    s.imageBytes = this.#images.bytes
    s.time = this.#time
  }

  /** Resize the canvas backing store to the adaptive render size. */
  #size(): [number, number] {
    const c = this.#canvas
    const dpr = globalThis.devicePixelRatio || 1
    const { width, height } = this.#quality.renderSize(
      c.clientWidth || 540,
      c.clientHeight || 960,
      dpr,
    )
    if (c.width !== width || c.height !== height) {
      c.width = width
      c.height = height
    }
    return [width, height]
  }

  #nextDraw(): LayerDraw {
    let d = this.#draws[this.#drawCount]
    if (!d) {
      d = createLayerDraw()
      this.#draws.push(d)
    }
    this.#drawCount++
    return d
  }

  /** Compose the frame at t. Sets #complete when every visible source had exact pixels. */
  #render(t: number): void {
    const comp = this.#comp!
    const index = this.#index
    const p = this.#project
    this.#dirty = false
    this.#complete = true
    this.#drawCount = 0
    const [w, h] = this.#size()
    comp.begin(w, h)
    const bg = hexToRgb(p?.settings.background ?? '#000000')
    if (!index || !p) {
      comp.clear('acc', bg[0], bg[1], bg[2])
      comp.present()
      return
    }
    const plan = index.resolve(t, this.#plan)
    this.#updatePool(t, index)

    const fill = p.settings.backgroundBlur
    if (plan.transition && plan.mainB.clip) {
      this.#mainFrame('a', plan.mainA, plan.overlays, plan.overlaysBelowMain, bg, fill, t)
      this.#mainFrame('b', plan.mainB, plan.overlays, plan.overlaysBelowMain, bg, fill, t)
      comp.transition(TRANSITION_ID[plan.transition], 1 - plan.progress)
    } else {
      this.#mainFrame('acc', plan.mainA, plan.overlays, plan.overlaysBelowMain, bg, fill, t)
    }
    for (let i = plan.overlaysBelowMain; i < plan.overlayCount; i++)
      this.#layer('acc', plan.overlays[i]!, t)
    comp.present()
    this.#text?.render(t)
    if (this.#playing && !this.#waiting) this.#audio.schedule(t)
    const s = this.stats
    s.framesComposited++
    if (this.#playing && !this.#waiting && !this.#complete) s.inexactFrames++
    s.frameExact = this.#complete
    s.textureUploads = comp.stats.uploads
    s.drawCalls = comp.stats.draws
    s.renderWidth = w
    s.renderHeight = h
    if ((s.framesComposited & 255) === 0) comp.sweep()
  }

  /** Background, below-main overlays and one main clip into `target`. */
  #mainFrame(
    target: TargetName,
    main: Slot,
    overlays: readonly Slot[],
    below: number,
    bg: readonly [number, number, number],
    fill: boolean,
    t: number,
  ): void {
    const comp = this.#comp!
    comp.clear(target, bg[0], bg[1], bg[2])
    const clip = main.clip
    if (fill && clip && clip.type !== 'sticker') {
      const src = this.#pool.get(clip)
      const info = src && asLayerSource(src)
      const frame = src && info ? src.frame(sourceTimeAt(clip, main.local)) : null
      if (info && frame) {
        const d = this.#fill
        d.key = poolKey(clip)
        d.image = frame.image
        d.version = frame.version
        computeLayer(clip, main.local, info, this.#layerCtx, d.layer) // for the crop rect
        computeFill(info, d.layer.uv, d.layer)
        d.adjOn = false
        d.blurPx = BACKGROUND_BLUR_PX
        d.lut = undefined
        d.keyOn = false
        d.blend = 0
        d.bgMode = BG_MODE.off
        comp.layer(target, d)
      }
    }
    for (let i = 0; i < below; i++) this.#layer(target, overlays[i]!, t)
    if (clip) this.#layer(target, main, t)
  }

  /** Draw one clip slot as a layer. */
  #layer(target: TargetName, slot: Slot, t: number): void {
    const clip = slot.clip
    if (!clip) return
    const src = this.#pool.get(clip)
    if (!src) {
      this.#complete = false
      return
    }
    const info = asLayerSource(src)
    const isMedia = clip.type !== 'sticker'
    const srcT = isMedia ? sourceTimeAt(clip, slot.local) : 0
    const frame = info ? src.frame(srcT) : null
    if (!info || !frame) {
      if (!src.error) this.#complete = false
      return
    }
    if (!frame.exact) this.#complete = false
    const d = this.#nextDraw()
    d.key = poolKey(clip)
    d.image = frame.image
    d.version = frame.version
    computeLayer(clip, slot.local, info, this.#layerCtx, d.layer)
    d.seed = (t / 1e6) % 97
    if (isMedia) {
      const m = clip
      const u = adjustUniforms(m.adjustments)
      d.adjOn = u.on
      d.adj.set(u.adj)
      d.curves = u.curves
      d.blurPx = u.blurPx
      const f = m.filter
      d.lut = f && f.intensity > 0 ? this.#luts?.get(f.ref) : undefined
      // a LUT still loading makes the frame provisional; a missing/broken one is skipped
      if (f && f.intensity > 0 && !d.lut && this.#luts?.pending(f.ref)) this.#complete = false
      d.lutMix = f?.intensity ?? 0
      d.keyOn = !!m.chromaKey?.enabled
      if (m.chromaKey?.enabled) d.keyParams.set(chromaKeyUniforms(m.chromaKey))
      d.blend = BLEND_ID[m.blendMode]
      this.#background(d, m, srcT)
    } else {
      d.adjOn = false
      d.blurPx = 0
      d.lut = undefined
      d.keyOn = false
      d.blend = 0
      d.bgMode = BG_MODE.off
    }
    this.#comp!.layer(target, d)
  }

  /**
   * AI background of a media layer: the matte frame at the same source time plus the
   * background parameters (core's BACKGROUND_BLUR_SIGMA / MATTE_FEATHER_SIGMA, as exported).
   * Without a matte frame yet the layer draws unmodified and the frame is provisional.
   */
  #background(d: LayerDraw, clip: MediaClip, srcT: number): void {
    d.bgMode = BG_MODE.off
    const bg = clip.background
    if (!bg || bg.mode === 'keep' || !this.#matteUrl(clip)) return
    const src = this.#mattes.get(clip)
    const frame = src?.info ? src.frame(srcT) : null
    if (!frame) {
      if (!src?.error) this.#complete = false
      return
    }
    if (!frame.exact) this.#complete = false
    d.matte.key = `m|${poolKey(clip)}`
    d.matte.image = frame.image
    d.matte.version = frame.version
    d.featherPx = bg.feather * MATTE_FEATHER_SIGMA
    d.bgBlurPx = bg.blur * BACKGROUND_BLUR_SIGMA
    const rgb = hexToRgb(bg.color)
    d.bgColor[0] = rgb[0]
    d.bgColor[1] = rgb[1]
    d.bgColor[2] = rgb[2]
    d.bgMode = BG_MODE[bg.mode]
    if (bg.mode !== 'image') return
    const img = this.#bgImage(bg.assetId)
    const f = img?.info ? img.frame() : null
    if (!img?.info || !f) {
      if (img && !img.error) this.#complete = false
      d.bgMode = BG_MODE.color
      return
    }
    d.bgImage.key = `bg|${bg.assetId ?? ''}`
    d.bgImage.image = f.image
    d.bgImage.version = f.version
    coverRect(
      d.layer.width / Math.max(1e-6, d.layer.height),
      img.info.width / Math.max(1, img.info.height),
      d.bgUV,
    )
  }

  /** Keep decoders for visible + upcoming clips open and tell them what is wanted. */
  #updatePool(t: number, index: TimelineIndex): void {
    const horizon = this.#playing ? PLAY_HORIZON_US : PAUSE_HORIZON_US
    const slots = this.#collect
    const n = index.collect(t, horizon, slots)
    // visible-first priority = ascending rendered start (insertion sort: n is tiny)
    for (let i = 1; i < n; i++) {
      const s = slots[i]!
      let j = i - 1
      while (j >= 0 && slots[j]!.start > s.start) {
        slots[j + 1] = slots[j]!
        j--
      }
      slots[j + 1] = s
    }
    const clips = this.#needed
    clips.length = n
    for (let i = 0; i < n; i++) clips[i] = slots[i]!.clip!
    const now = performance.now()
    this.#pool.update(clips, n, now)
    this.#mattes.update(clips, n, now)
    const playing = this.#playing && !this.#waiting
    for (let i = 0; i < n; i++) {
      const s = slots[i]!
      const clip = s.clip!
      if (clip.type === 'sticker') continue
      const local = s.local >= 0 ? s.local : 0
      const t = sourceTimeAt(clip, local)
      const rate = sourceRateAt(clip, local)
      const play = s.local >= 0 && playing // pre-roll: first frame only
      this.#pool.get(clip)?.want(t, play, rate)
      this.#mattes.get(clip)?.want(t, play, rate)
    }
  }

  /* ------------------------------------------------------------------ snapshot / teardown */

  async snapshot(
    opts: { type?: 'image/png' | 'image/webp'; quality?: number } = {},
  ): Promise<Blob> {
    if (this.#lost || !this.#comp) throw new GlError('WebGL context lost')
    this.#render(this.#time)
    const img = this.#comp.readPixels()
    const out = new OffscreenCanvas(img.width, img.height)
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.putImageData(img, 0, 0)
    const text = await this.#text?.capture(this.#time)
    if (text && text.width > 0 && text.height > 0) {
      const bmp = await createImageBitmap(
        new ImageData(new Uint8ClampedArray(text.data), text.width, text.height),
      )
      ctx.drawImage(bmp, 0, 0, img.width, img.height)
      bmp.close()
    }
    return out.convertToBlob({ type: opts.type ?? 'image/png', quality: opts.quality ?? 0.92 })
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    cancelAnimationFrame(this.#raf)
    clearTimeout(this.#assTimer)
    this.#canvas.removeEventListener('webglcontextlost', this.#onLost)
    this.#canvas.removeEventListener('webglcontextrestored', this.#onRestored)
    this.#pool.closeAll()
    this.#mattes.closeAll()
    for (const s of this.#bgImages.values()) s.close()
    this.#bgImages.clear()
    this.#images.clear()
    this.#audio.destroy()
    this.#text?.destroy()
    this.#luts?.clear()
    this.#comp?.dispose()
    this.#listeners.clear()
    const g = globalThis as { __rfPreviewStats?: PreviewStats }
    if (g.__rfPreviewStats === this.stats) delete g.__rfPreviewStats
  }
}

/**
 * Cover-fit rect (u0, v0, u1, v1 in image UV) of an image with aspect `ia` filling a frame
 * with aspect `fa` — the export's `scale=…:force_original_aspect_ratio=increase,crop`.
 */
export function coverRect(fa: number, ia: number, out: Float32Array): void {
  if (ia > fa) {
    const w = fa / ia
    out[0] = (1 - w) / 2
    out[1] = 0
    out[2] = (1 + w) / 2
    out[3] = 1
  } else {
    const h = ia / fa
    out[0] = 0
    out[1] = (1 - h) / 2
    out[2] = 1
    out[3] = (1 + h) / 2
  }
}

/** Create a preview engine drawing into `canvas` (which it owns until `destroy()`). */
export function createPreviewEngine(
  canvas: HTMLCanvasElement,
  opts: PreviewEngineOptions,
): PreviewEngine {
  return new Engine(canvas, opts)
}
