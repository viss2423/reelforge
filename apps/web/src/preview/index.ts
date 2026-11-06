/**
 * Preview engine public API (see docs/ARCHITECTURE.md). The editor depends ONLY on this file.
 * STUB — implemented by the preview builder.
 */
import type { Asset, Project, Us } from '@reelforge/core'

export interface PreviewEngineOptions {
  mediaUrl(assetId: string, variant: 'proxy' | 'original'): string
  assUrl(projectId: string, revision: number): string
  packFileUrl(path: string): string
  fonts: { family: string; url: string }[]
}

export type PreviewEvent = 'time' | 'play' | 'pause' | 'ended' | 'waiting'

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
  snapshot(): Promise<Blob>
  destroy(): void
}

export function createPreviewEngine(
  canvas: HTMLCanvasElement,
  opts: PreviewEngineOptions,
): PreviewEngine {
  void canvas
  void opts
  throw new Error('preview engine not implemented yet')
}
