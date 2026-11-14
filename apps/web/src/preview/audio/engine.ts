/**
 * WebAudio mix for the preview.
 *
 * Graph: AudioBufferSourceNode (per piece) → GainNode (per voice: volume, fades, ducking
 * automation) → master GainNode → DynamicsCompressor configured as a brick-wall-ish limiter
 * → destination. Pieces are scheduled ~{@link LOOKAHEAD_US} ahead on the AudioContext
 * timeline, which is sample-accurate and immune to main-thread jank; the video clock slaves
 * itself to the audio output time (see clock.ts), so A/V stay locked.
 *
 * Speed: `playbackRate` = clip speed. WebAudio has no pitch-preserving time-stretch, so
 * `preservePitch` is approximated (pitch shifts with speed in the preview; the export uses
 * rubberband). Speed ramps use the clip's base speed for audio.
 *
 * iOS: an AudioContext starts suspended until a user gesture; {@link AudioEngine.unlock}
 * resumes it (and plays a 1-sample buffer, which WebKit requires) on the first gesture.
 */
import type { MediaFiles } from '../media/mediaFile.ts'
import {
  gainBreakpoints,
  PiecePlanner,
  toCtxTime,
  type AudioAnchor,
  type PieceStart,
} from './schedule.ts'
import { AudioSegments } from './segments.ts'
import { duckIntervals, type Interval, type Voice } from './voices.ts'

/** How far ahead (us) sources and automation are scheduled. */
export const LOOKAHEAD_US = 1_000_000
/** Delay between play() and the first sample (s): room to schedule without clipping. */
const START_LEAD_S = 0.05
/** Fade applied when stopping, to avoid clicks (s). */
const STOP_FADE_S = 0.015

interface VoiceNode {
  gain: GainNode
  /** Timeline time up to which automation is scheduled. */
  until: number
}

export interface AudioEngineOptions {
  files: MediaFiles
  /** Proxy/original URL for an asset id. */
  urlOf(assetId: string): string | undefined
  /** Decoded-audio cache budget in bytes. */
  cacheBytes: number
}

export class AudioEngine {
  readonly ctx: AudioContext
  readonly #master: GainNode
  readonly #segments: AudioSegments
  readonly #opts: AudioEngineOptions
  readonly #planner = new PiecePlanner()
  readonly #starts: PieceStart[] = []
  readonly #bp: number[] = []
  #voices: Voice[] = []
  #duck: Interval[] = []
  #nodes = new Map<string, VoiceNode>()
  #sources = new Set<AudioBufferSourceNode>()
  #anchor: AudioAnchor | undefined
  #playing = false
  #unlockCleanup: (() => void) | undefined

  constructor(opts: AudioEngineOptions) {
    this.#opts = opts
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    const limiter = this.ctx.createDynamicsCompressor()
    limiter.threshold.value = -1
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.003
    limiter.release.value = 0.1
    this.#master = this.ctx.createGain()
    this.#master.connect(limiter).connect(this.ctx.destination)
    this.#segments = new AudioSegments(this.ctx, opts.files, opts.cacheBytes)
    this.#segments.onReady = () => {
      if (this.#playing && this.#anchor) this.schedule(this.#nowTimeline())
    }
  }

  /** True when the context is running (unlocked) — only then is audio the master clock. */
  get running(): boolean {
    return this.ctx.state === 'running'
  }

  get anchor(): AudioAnchor | undefined {
    return this.#anchor
  }

  get decodedBytes(): number {
    return this.#segments.bytes
  }

  /**
   * Resume the context on the first user gesture (required on iOS/Safari and by Chrome's
   * autoplay policy). Safe to call repeatedly.
   */
  unlock(target: EventTarget = window): void {
    if (this.running || this.#unlockCleanup) return
    const events = ['pointerdown', 'touchend', 'keydown', 'click'] as const
    const onGesture = (): void => {
      void this.ctx.resume().then(() => {
        const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
        const s = this.ctx.createBufferSource()
        s.buffer = b
        s.connect(this.ctx.destination)
        s.start()
        cleanup()
        this.onUnlock?.()
      })
    }
    const cleanup = (): void => {
      for (const e of events) target.removeEventListener(e, onGesture, true)
      this.#unlockCleanup = undefined
    }
    for (const e of events) target.addEventListener(e, onGesture, true)
    this.#unlockCleanup = cleanup
  }

  /** Called after a gesture unlocked the context (engine re-anchors a running playback). */
  onUnlock: (() => void) | undefined

  /** Replace the mix (project changed). Running playback is rescheduled seamlessly. */
  setVoices(voices: Voice[]): void {
    this.#voices = voices
    this.#duck = duckIntervals(voices)
    const urls = new Set<string>()
    for (const v of voices) {
      const u = this.#opts.urlOf(v.assetId)
      if (u) urls.add(u)
    }
    this.#segments.retain(urls)
    if (this.#playing && this.#anchor) {
      const t = this.#nowTimeline()
      this.#stopSources(false)
      this.#anchor = { t, ctxTime: this.ctx.currentTime + START_LEAD_S }
      this.schedule(t)
    }
  }

  /** Warm the cache for audio around timeline time t (seek / idle). */
  prefetch(t: number): void {
    for (const v of this.#voices) {
      if (t < v.start - LOOKAHEAD_US || t >= v.end) continue
      const url = this.#opts.urlOf(v.assetId)
      const seg = url ? this.#segments.segmentLength(url) : undefined
      if (!url || seg === undefined) continue
      const local = Math.max(t, v.start) - v.start
      const src = v.reverse ? v.in + (v.end - v.start - local) * v.speed : v.in + local * v.speed
      this.#segments.get(url, Math.floor(Math.max(0, src - (v.reverse ? 1 : 0)) / seg), v.reverse)
    }
  }

  /**
   * Start playback at timeline time t. Returns the AudioContext time at which t will be
   * heard (the master-clock anchor), or undefined when the context is locked.
   */
  play(t: number): number | undefined {
    this.#stopSources(false)
    this.#playing = true
    if (!this.running) {
      this.#anchor = undefined
      void this.ctx.resume().catch(() => undefined)
      return undefined
    }
    this.#master.gain.cancelScheduledValues(this.ctx.currentTime)
    this.#master.gain.setValueAtTime(1, this.ctx.currentTime)
    this.#anchor = { t, ctxTime: this.ctx.currentTime + START_LEAD_S }
    this.schedule(t)
    return this.#anchor.ctxTime
  }

  stop(): void {
    this.#playing = false
    this.#stopSources(true)
    this.#anchor = undefined
  }

  /** Timeline time currently being heard (approx.; the engine clock is authoritative). */
  #nowTimeline(): number {
    const a = this.#anchor!
    return a.t + Math.max(0, this.ctx.currentTime - a.ctxTime) * 1e6
  }

  // planner callbacks as fields: the per-frame schedule() allocates no closures
  readonly #segLen = (v: Voice): number | undefined => {
    const u = this.#opts.urlOf(v.assetId)
    return u ? this.#segments.segmentLength(u) : undefined
  }

  readonly #segReady = (v: Voice, seg: number): boolean => {
    const u = this.#opts.urlOf(v.assetId)
    return u !== undefined && this.#segments.get(u, seg, v.reverse) !== undefined
  }

  /** Schedule everything due in [t, t + LOOKAHEAD]. Called from the frame loop. */
  schedule(t: number): void {
    const a = this.#anchor
    if (!this.#playing || !a || !this.running) return
    const from = Math.max(t, a.t)
    const to = from + LOOKAHEAD_US
    const n = this.#planner.plan(this.#voices, from, to, this.#segLen, this.#segReady, this.#starts)
    for (let i = 0; i < n; i++) this.#startPiece(this.#starts[i]!, a)
    for (const v of this.#voices) {
      if (v.end <= from || v.start >= to) continue
      this.#automate(v, from, to, a)
    }
    // keep upcoming segments decoding before they are due
    this.prefetch(to)
  }

  #voiceNode(v: Voice): VoiceNode {
    let node = this.#nodes.get(v.clipId)
    if (!node) {
      const gain = this.ctx.createGain()
      gain.connect(this.#master)
      node = { gain, until: -1 }
      this.#nodes.set(v.clipId, node)
    }
    return node
  }

  #automate(v: Voice, from: number, to: number, a: AudioAnchor): void {
    const node = this.#voiceNode(v)
    const start = Math.max(from, node.until)
    if (start >= to) return
    const pairs = gainBreakpoints(v, this.#duck, start, to, this.#bp)
    const g = node.gain.gain
    const now = this.ctx.currentTime
    for (let i = 0; i < pairs; i++) {
      const when = Math.max(now, toCtxTime(a, this.#bp[2 * i]!))
      const val = this.#bp[2 * i + 1]!
      if (i === 0 && node.until < 0) g.setValueAtTime(val, when)
      else g.linearRampToValueAtTime(val, when)
    }
    node.until = to
  }

  #startPiece(p: PieceStart, a: AudioAnchor): void {
    const v = this.#voices[p.voice]!
    const url = this.#opts.urlOf(v.assetId)
    const seg = url ? this.#segments.segmentLength(url) : undefined
    const buf = url && seg !== undefined ? this.#segments.get(url, p.seg, v.reverse) : undefined
    if (!buf || seg === undefined) return
    const segStart = p.seg * seg
    // offset inside the (possibly reversed) buffer, in seconds of SOURCE time
    const offset = v.reverse
      ? (segStart + Math.min(seg, buf.duration * 1e6) - p.srcEnd) / 1e6
      : (p.srcStart - segStart) / 1e6
    const dur = (p.srcEnd - p.srcStart) / 1e6
    if (offset >= buf.duration || dur <= 0) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = v.speed
    src.connect(this.#voiceNode(v).gain)
    const when = toCtxTime(a, p.when)
    const late = Math.max(0, this.ctx.currentTime - when)
    src.start(when + late, Math.max(0, offset + late * v.speed), Math.max(0, dur - late * v.speed))
    src.onended = () => {
      src.disconnect()
      this.#sources.delete(src)
    }
    this.#sources.add(src)
  }

  #stopSources(fade: boolean): void {
    const now = this.ctx.currentTime
    if (fade && this.#sources.size > 0) {
      const g = this.#master.gain
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(0, now + STOP_FADE_S)
    }
    for (const s of this.#sources) {
      s.onended = null
      try {
        s.stop(fade ? now + STOP_FADE_S : 0)
      } catch {
        // already stopped
      }
    }
    this.#sources.clear()
    for (const n of this.#nodes.values()) {
      n.gain.gain.cancelScheduledValues(now)
      const node = n.gain
      if (fade) setTimeout(() => node.disconnect(), STOP_FADE_S * 1000 + 50)
      else node.disconnect()
    }
    this.#nodes = new Map()
    this.#planner.reset()
  }

  destroy(): void {
    this.stop()
    this.#unlockCleanup?.()
    this.#segments.clear()
    void this.ctx.close().catch(() => undefined)
  }
}
