/**
 * Common interface of everything that supplies pixels for a layer: WebCodecs decoders,
 * the <video> fallback and still images / stickers.
 */
import type { Rotation } from '../timeline/layers.ts'

export interface FrameHandle {
  /** Pixels to upload (VideoFrame, HTMLVideoElement or ImageBitmap). */
  readonly image: TexImageSource
  /** Source time (us) the pixels belong to. */
  readonly timestamp: number
  /** True when the pixels are exactly the frame wanted (not a stale neighbour). */
  readonly exact: boolean
  /** Changes whenever the pixels change (texture upload cache key). */
  readonly version: number
}

export interface SourceInfo {
  width: number
  height: number
  rotation: Rotation
  /** Duration in us (0 for stills). */
  duration: number
}

export interface PixelSource {
  readonly kind: 'webcodecs' | 'element' | 'image'
  /** Undefined until the source is opened. */
  readonly info: SourceInfo | undefined
  /** Set when the source cannot be used (codec unsupported, decode error, 404…). */
  readonly error: Error | undefined
  /**
   * Hint the time that will be displayed next (source us) so decoding can start early.
   * `playing` enables read-ahead; `rate` is the source-time speed (clip speed, <0 reverse).
   */
  want(t: number, playing: boolean, rate: number): void
  /** Best pixels for source time t right now (exact, else nearest decoded), or null. */
  frame(t: number): FrameHandle | null
  close(): void
}

/** Shared counters exposed through `window.__rfPreviewStats`. */
export interface MediaStats {
  framesDecoded: number
  decoderResets: number
  bytesFetched: number
  activeDecoders: number
}

export const createMediaStats = (): MediaStats => ({
  framesDecoded: 0,
  decoderResets: 0,
  bytesFetched: 0,
  activeDecoders: 0,
})
