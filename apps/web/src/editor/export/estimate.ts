/**
 * Export size estimate shown before rendering. These mirror the server's encoder targets
 * closely enough for a "~45 MB" hint; the real size depends on content complexity.
 */
import { ExportSettings, US_PER_SECOND, type Us } from '@reelforge/core'

/** H.264 video bitrate (Mbit/s) at 1080×1920 30 fps per quality. */
const H264_1080P30: Record<ExportSettings['quality'], number> = {
  draft: 6,
  standard: 10,
  high: 16,
  max: 25,
}

/** Bitrate scales sub-linearly with pixel count (encoders exploit the redundancy). */
const RESOLUTION_FACTOR: Record<ExportSettings['resolution'], number> = {
  '720p': 0.5,
  '1080p': 1,
  '1440p': 1.65,
  '2160p': 3.2,
}

/** Same perceived quality at lower bitrate for newer codecs. */
const CODEC_FACTOR: Record<ExportSettings['codec'], number> = { h264: 1, hevc: 0.65, av1: 0.55 }

/** AAC 320 kbit/s. */
export const AUDIO_KBPS = 320

/** Video bitrate in Mbit/s for the given settings at `fps`. */
export const videoMbps = (
  s: Pick<ExportSettings, 'quality' | 'resolution' | 'codec'>,
  fps: number,
): number =>
  H264_1080P30[s.quality] *
  RESOLUTION_FACTOR[s.resolution] *
  CODEC_FACTOR[s.codec] *
  (fps / 30) ** 0.6

/** Estimated file size in bytes for `duration` microseconds. */
export const estimateExportBytes = (
  s: Pick<ExportSettings, 'quality' | 'resolution' | 'codec' | 'range'>,
  fps: number,
  duration: Us,
): number => {
  const span = s.range ? Math.max(0, s.range.end - s.range.start) : duration
  const seconds = span / US_PER_SECOND
  const mbps = videoMbps(s, fps) + AUDIO_KBPS / 1000
  return Math.round((mbps * 1_000_000 * seconds) / 8)
}

const SETTINGS_KEY = 'rf.exportSettings'

/** Last used export settings (per device), validated so a schema change can't break the dialog. */
export const loadExportSettings = (): ExportSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const parsed = ExportSettings.safeParse(raw ? JSON.parse(raw) : {})
    if (parsed.success) {
      const { range: _range, ...rest } = parsed.data
      return ExportSettings.parse(rest)
    }
  } catch {
    // Fall through to defaults.
  }
  return ExportSettings.parse({})
}

export const saveExportSettings = (s: ExportSettings): void => {
  try {
    const { range: _range, ...rest } = s
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest))
  } catch {
    // Non-essential.
  }
}
