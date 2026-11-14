/**
 * <video> fallback for browsers without WebCodecs (or codecs it rejects). Not frame-exact:
 * seeks land on the nearest decodable frame and playback is slaved to the engine clock by
 * nudging `playbackRate` (small drift) or seeking (large drift).
 *
 * Where `requestVideoFrameCallback` exists (all current engines) the timestamp of the frame
 * actually PRESENTED is tracked, so "exact" means the right pixels are on the texture, not
 * merely that `currentTime` was set; elsewhere `currentTime` is the best available proxy.
 */
import type { FrameHandle, MediaStats, PixelSource, SourceInfo } from './source.ts'

/** Drift (s) beyond which the element is re-seeked instead of rate-nudged. */
const RESEEK_S = 0.25
/** Paused: the presented frame must be the wanted 30 fps frame. */
const EXACT_PAUSED_US = 34_000
/**
 * Playing: drift the rate correction is still absorbing. A playing element always lags the
 * clock by its start-up and presentation latency; treating that as starvation would stall
 * playback, pause the element and restart it — which creates the same lag again.
 */
const EXACT_PLAYING_US = 120_000

export class ElementSource implements PixelSource {
  readonly kind = 'element'
  info: SourceInfo | undefined
  error: Error | undefined
  readonly #video: HTMLVideoElement
  readonly #stats: MediaStats
  #version = 0
  #lastTime = -1
  /** Media time (us) of the last presented frame (rVFC), or −1 when untracked. */
  #presented = -1
  #closed = false
  readonly #handle = {
    image: null as unknown as TexImageSource,
    timestamp: 0,
    exact: false,
    version: 0,
  }

  constructor(url: string, stats: MediaStats) {
    this.#stats = stats
    const v = document.createElement('video')
    v.muted = true // audio comes from the WebAudio graph
    v.playsInline = true
    v.preload = 'auto'
    v.disableRemotePlayback = true
    v.addEventListener('loadedmetadata', () => {
      this.info = {
        width: v.videoWidth,
        height: v.videoHeight,
        rotation: 0,
        duration: v.duration * 1e6,
      }
    })
    v.addEventListener('error', () => {
      this.error = new Error(`video element failed: ${v.error?.message ?? 'unknown'}`)
    })
    v.src = url
    this.#video = v
    stats.activeDecoders++
    if (typeof v.requestVideoFrameCallback === 'function') {
      const onFrame: VideoFrameRequestCallback = (_now, meta) => {
        if (this.#closed) return
        this.#presented = Math.round(meta.mediaTime * 1e6)
        this.#version++
        this.#stats.framesDecoded++
        v.requestVideoFrameCallback(onFrame)
      }
      v.requestVideoFrameCallback(onFrame)
    }
  }

  want(t: number, playing: boolean, rate: number): void {
    const v = this.#video
    if (v.readyState < 1) return
    const target = t / 1e6
    const forward = playing && rate > 0
    if (forward) {
      const drift = v.currentTime - target
      if (Math.abs(drift) > RESEEK_S) v.currentTime = target
      // proportional correction, bounded so pitch-less video never visibly races
      v.playbackRate = Math.min(
        16,
        Math.max(0.0625, rate * (1 - Math.max(-0.1, Math.min(0.1, drift)))),
      )
      if (v.paused) void v.play().catch(() => undefined)
    } else {
      if (!v.paused) v.pause()
      if (!v.seeking && Math.abs(v.currentTime - target) > 0.001) v.currentTime = target
    }
  }

  frame(t: number): FrameHandle | null {
    const v = this.#video
    if (v.readyState < 2) return null
    const h = this.#handle
    if (this.#presented < 0 && v.currentTime !== this.#lastTime) {
      this.#lastTime = v.currentTime
      this.#version++
      this.#stats.framesDecoded++
    }
    h.image = v
    h.timestamp = this.#presented >= 0 ? this.#presented : v.currentTime * 1e6
    // the element cannot address frames exactly: accept the nearest presented frame
    const tolerance = v.paused ? EXACT_PAUSED_US : EXACT_PLAYING_US
    h.exact = !v.seeking && Math.abs(h.timestamp - t) < tolerance
    h.version = this.#version
    return h
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const v = this.#video
    v.pause()
    v.removeAttribute('src')
    v.load() // releases the decoder immediately (iOS caps concurrent media elements)
    this.#stats.activeDecoders--
  }
}
