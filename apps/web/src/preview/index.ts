/**
 * Preview engine public API (see docs/ARCHITECTURE.md and ./README.md). The editor depends
 * ONLY on this file. Everything beyond the original contract is optional and additive.
 */
import type { AnimationPreset, Asset, EffectPreset, Project, Us } from '@reelforge/core'
import type { ByteSource } from './media/byteSource.ts'

export interface PreviewEngineOptions {
  mediaUrl(assetId: string, variant: 'proxy' | 'original'): string
  /**
   * Server-generated .ass URL. Kept for compatibility; the engine builds the .ass in the
   * browser with core's `buildAss` so text edits show with zero latency.
   */
  assUrl(projectId: string, revision: number): string
  packFileUrl(path: string): string
  fonts: { family: string; url: string }[]
  /** `<packId>/<animationId>` or `builtin/<id>` → preset (text + sticker animations). */
  resolveAnimation?: ((ref: string) => AnimationPreset | undefined) | undefined
  /** `<packId>/<effectId>` → effect preset. */
  resolveEffect?: ((ref: string) => EffectPreset | undefined) | undefined
  /** `<packId>/<filterId>` → URL of the filter's .cube LUT. */
  resolveLut?: ((ref: string) => string | undefined) | undefined
  /** `<packId>/<stickerId>` → URL of the sticker image. */
  resolveSticker?: ((ref: string) => string | undefined) | undefined
  /** Custom byte reader for a media URL (dev harness: local files). Defaults to HTTP Range. */
  openMedia?: ((url: string) => ByteSource) | undefined
  /** Force a decode path (testing); default picks WebCodecs when available. */
  decoder?: 'auto' | 'webcodecs' | 'element' | undefined
  /** JASSUB asset URL overrides for bundlers that cannot resolve them automatically. */
  jassub?: { workerUrl?: string; wasmUrl?: string; modernWasmUrl?: string } | undefined
}

export type PreviewEvent = 'time' | 'play' | 'pause' | 'ended' | 'waiting'

/** Live counters (also published as `window.__rfPreviewStats` for Playwright). */
export interface PreviewStats {
  /** Frames composited per second (EMA). */
  fps: number
  /** CPU time of the last frame's compose, ms (EMA). */
  frameMs: number
  /** Backing-store size of the canvas. */
  renderWidth: number
  renderHeight: number
  /** Adaptive quality level (0 = full). */
  qualityLevel: number
  framesComposited: number
  /** Frames shown during playback whose video pixels were not the exact wanted frame. */
  inexactFrames: number
  /** Whether the last composited frame showed exact pixels for every layer (seek settled). */
  frameExact: boolean
  framesDecoded: number
  decoderResets: number
  activeDecoders: number
  bytesFetched: number
  textureUploads: number
  drawCalls: number
  gpuBytes: number
  audioDecodedBytes: number
  imageBytes: number
  waiting: boolean
  decoder: 'webcodecs' | 'element'
  time: Us
}

export interface PreviewEngine {
  setProject(p: Project, assets: Readonly<Record<string, Asset>>): void
  seek(t: Us): void
  play(): void
  pause(): void
  readonly playing: boolean
  readonly time: Us
  on(event: PreviewEvent, cb: (t: Us) => void): () => void
  setQuality(q: 'auto' | 'low' | 'high'): void
  /** Draw the frame at the current time into the canvas (used for thumbnails/snapshots). */
  snapshot(opts?: { type?: 'image/png' | 'image/webp'; quality?: number }): Promise<Blob>
  destroy(): void
  /** Rendered project duration (main track with transition overlap, other tracks, captions). */
  readonly duration?: Us
  /** Audio solo: when non-empty only these track ids are heard (track `muted` still applies). */
  setSolo?(trackIds: readonly string[]): void
  /** Live counters for overlays and e2e tests. */
  readonly stats?: Readonly<PreviewStats>
}

export { createPreviewEngine } from './engine.ts'
