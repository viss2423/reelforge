/**
 * "Preview with my reel": the official 30 s preview of a trending sound, played by the
 * preview engine in sync with the edit (looping on longer reels) instead of the project's
 * music bed. The audio is fetched through the host for playback only — it lives in memory
 * here, is never uploaded as an asset and never reaches an export.
 */
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

export interface PreviewedSound {
  title: string
  artist?: string
  bpm?: number
  /** Provider of the preview clip (`deezer`). */
  source: string
}

export interface SoundPreviewState {
  sound: PreviewedSound | undefined
  /** Encoded preview audio (MP3/AAC) for the engine to decode. */
  audio: ArrayBuffer | undefined
  /**
   * A trending sound was previewed or its name copied this session → the export defaults
   * to "No music" (the creator adds the sound in Instagram).
   */
  soundPicked: boolean
  start(sound: PreviewedSound, audio: ArrayBuffer): void
  pick(): void
  stop(): void
}

export const soundPreviewStore = createStore<SoundPreviewState>()((set) => ({
  sound: undefined,
  audio: undefined,
  soundPicked: false,
  start: (sound, audio) => set({ sound, audio, soundPicked: true }),
  pick: () => set({ soundPicked: true }),
  stop: () => set({ sound: undefined, audio: undefined }),
}))

export const useSoundPreview = <T>(sel: (s: SoundPreviewState) => T): T =>
  useStore(soundPreviewStore, sel)

/** Length of Deezer's official preview clips. */
export const PREVIEW_CLIP_US = 30_000_000
