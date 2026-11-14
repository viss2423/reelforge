/**
 * Video encoder selection and tuning for exports and previews.
 *
 * Output is tuned for Instagram Reels / TikTok / Shorts ingest: CFR, closed GOP of 2 s,
 * H.264 High profile (or HEVC Main tagged `hvc1`, or AV1 Main), 4:2:0 8-bit, BT.709 tags
 * (set by the compiler), `+faststart`, AAC-LC 48 kHz. Platforms re-encode everything, so
 * uploads should be high-bitrate and artefact-free rather than small.
 *
 * Bitrate targets (H.264, 1080×1920 @ 30 fps; `vbr_peak`/capped-CRF peak = 1.5× target):
 *
 * | quality  | target  | peak    | CPU preset / CRF (x264) | AMF -quality |
 * | -------- | ------- | ------- | ----------------------- | ------------ |
 * | draft    |  6 Mb/s |  9 Mb/s | veryfast / 23           | speed        |
 * | standard | 10 Mb/s | 15 Mb/s | faster   / 21           | balanced     |
 * | high     | 16 Mb/s | 24 Mb/s | medium   / 19           | quality      |
 * | max      | 24 Mb/s | 36 Mb/s | slow     / 17           | high_quality |
 *
 * Other sizes/rates scale the target by (pixels / 1080·1920)^0.85 × (fps / 30)^0.7
 * (bits per pixel fall as resolution and frame rate rise); HEVC uses 0.65× and AV1 0.5×
 * of the H.264 bitrate for the same perceived quality.
 */
import type { EncoderChoice, ExportSettings } from '@reelforge/core'
import type { Toolchain } from '../contracts.ts'

export type Quality = ExportSettings['quality']
export type Codec = ExportSettings['codec']

/** An encoder choice plus where it runs. */
export interface EncoderPick extends EncoderChoice {
  hardware: boolean
}

export interface EncodeTarget {
  width: number
  height: number
  fps: number
  quality: Quality
  codec: Codec
  /** Interactive preview: fastest presets, quality secondary. */
  preview?: boolean
}

const BASE_MBPS: Readonly<Record<Quality, number>> = {
  draft: 6,
  standard: 10,
  high: 16,
  max: 24,
}
const CODEC_EFFICIENCY: Readonly<Record<Codec, number>> = { h264: 1, hevc: 0.65, av1: 0.5 }
const REF_PIXELS = 1080 * 1920

/** Target average video bitrate in bits/s (see table in the module docs). */
export function videoBitrate(
  t: Pick<EncodeTarget, 'width' | 'height' | 'fps' | 'quality' | 'codec'>,
): number {
  const px = (t.width * t.height) / REF_PIXELS
  const mbps = BASE_MBPS[t.quality] * px ** 0.85 * (t.fps / 30) ** 0.7 * CODEC_EFFICIENCY[t.codec]
  return Math.round(mbps * 1000) * 1000
}

const kbps = (bps: number): string => `${Math.round(bps / 1000)}k`

/** Bitrate cap args shared by every rate-controlled encoder. */
function rateArgs(t: EncodeTarget): string[] {
  const b = videoBitrate(t)
  return ['-b:v', kbps(b), '-maxrate', kbps(b * 1.5), '-bufsize', kbps(b * 2)]
}

const gop = (t: EncodeTarget): number => Math.max(1, Math.round(t.fps * 2))

const profileArgs = (codec: Codec): string[] =>
  codec === 'h264' ? ['-profile:v', 'high'] : codec === 'hevc' ? ['-profile:v', 'main'] : []

/** HEVC in MP4 must be tagged hvc1 for Apple/Instagram playback. */
const tagArgs = (codec: Codec): string[] => (codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])

const AMF_QUALITY: Readonly<Record<Quality, string>> = {
  draft: 'speed',
  standard: 'balanced',
  high: 'quality',
  max: 'high_quality',
}

/** AMD AMF (Radeon iGPU/dGPU). */
function amf(video: string, t: EncodeTarget): EncoderPick {
  const quality = t.preview ? 'speed' : AMF_QUALITY[t.quality]
  // The HEVC/AV1 AMF encoders have no "high_quality" preset name.
  const preset = t.codec !== 'h264' && quality === 'high_quality' ? 'quality' : quality
  const args = [
    '-usage',
    'transcoding',
    '-quality',
    preset,
    '-rc',
    'vbr_peak',
    ...rateArgs(t),
    ...profileArgs(t.codec),
    ...tagArgs(t.codec),
    '-g',
    String(gop(t)),
  ]
  // B-frames: supported by the H.264 and AV1 AMF encoders on RDNA3 (silently ignored where
  // unsupported); pre-analysis improves rate allocation at a small cost.
  if (t.codec !== 'hevc' && !t.preview) args.push('-bf', '3')
  if (!t.preview && (t.quality === 'high' || t.quality === 'max')) {
    args.push('-preanalysis', '1', '-vbaq', '1')
  }
  return { video, args, pixFmt: 'nv12', hardware: true }
}

const NVENC_PRESET: Readonly<Record<Quality, string>> = {
  draft: 'p2',
  standard: 'p4',
  high: 'p5',
  max: 'p7',
}

/** NVIDIA NVENC. */
function nvenc(video: string, t: EncodeTarget): EncoderPick {
  return {
    video,
    args: [
      '-preset',
      t.preview ? 'p1' : NVENC_PRESET[t.quality],
      '-tune',
      'hq',
      '-rc',
      'vbr',
      ...rateArgs(t),
      ...profileArgs(t.codec),
      ...tagArgs(t.codec),
      '-g',
      String(gop(t)),
      '-bf',
      t.preview ? '0' : '3',
      '-spatial_aq',
      '1',
    ],
    pixFmt: 'nv12',
    hardware: true,
  }
}

const QSV_PRESET: Readonly<Record<Quality, string>> = {
  draft: 'veryfast',
  standard: 'medium',
  high: 'slow',
  max: 'veryslow',
}

/** Intel Quick Sync. */
function qsv(video: string, t: EncodeTarget): EncoderPick {
  return {
    video,
    args: [
      '-preset',
      t.preview ? 'veryfast' : QSV_PRESET[t.quality],
      ...rateArgs(t),
      ...profileArgs(t.codec),
      ...tagArgs(t.codec),
      '-g',
      String(gop(t)),
      '-bf',
      t.preview ? '0' : '3',
    ],
    pixFmt: 'nv12',
    hardware: true,
  }
}

/** Apple VideoToolbox. */
function videotoolbox(video: string, t: EncodeTarget): EncoderPick {
  return {
    video,
    args: [...rateArgs(t), ...profileArgs(t.codec), ...tagArgs(t.codec), '-g', String(gop(t))],
    pixFmt: t.codec === 'av1' ? 'yuv420p' : 'nv12',
    hardware: true,
  }
}

const X264: Readonly<Record<Quality, { preset: string; crf: number }>> = {
  draft: { preset: 'veryfast', crf: 23 },
  standard: { preset: 'faster', crf: 21 },
  high: { preset: 'medium', crf: 19 },
  max: { preset: 'slow', crf: 17 },
}
const X265: Readonly<Record<Quality, { preset: string; crf: number }>> = {
  draft: { preset: 'veryfast', crf: 26 },
  standard: { preset: 'fast', crf: 24 },
  high: { preset: 'medium', crf: 22 },
  max: { preset: 'slow', crf: 20 },
}
const SVT_AV1: Readonly<Record<Quality, { preset: number; crf: number }>> = {
  draft: { preset: 10, crf: 38 },
  standard: { preset: 8, crf: 34 },
  high: { preset: 6, crf: 30 },
  max: { preset: 4, crf: 26 },
}

/** Software encoder for a codec (the universal fallback). */
export function cpuEncoder(t: EncodeTarget): EncoderPick {
  const b = videoBitrate(t)
  const g = gop(t)
  switch (t.codec) {
    case 'h264': {
      const p = t.preview ? { preset: 'ultrafast', crf: 26 } : X264[t.quality]
      return {
        video: 'libx264',
        args: [
          '-preset',
          p.preset,
          '-crf',
          String(p.crf),
          // Capped CRF: constant quality, but never above the platform-friendly peak.
          '-maxrate',
          kbps(b * 1.5),
          '-bufsize',
          kbps(b * 2),
          '-profile:v',
          'high',
          '-g',
          String(g),
          '-flags',
          '+cgop',
        ],
        pixFmt: 'yuv420p',
        hardware: false,
      }
    }
    case 'hevc': {
      const p = t.preview ? { preset: 'ultrafast', crf: 28 } : X265[t.quality]
      return {
        video: 'libx265',
        args: [
          '-preset',
          p.preset,
          '-crf',
          String(p.crf),
          '-profile:v',
          'main',
          '-tag:v',
          'hvc1',
          '-x265-params',
          `keyint=${g}:min-keyint=${Math.max(1, Math.round(t.fps))}:open-gop=0:vbv-maxrate=${Math.round((b * 1.5) / 1000)}:vbv-bufsize=${Math.round((b * 2) / 1000)}:log-level=error`,
        ],
        pixFmt: 'yuv420p',
        hardware: false,
      }
    }
    case 'av1': {
      const p = t.preview ? { preset: 12, crf: 40 } : SVT_AV1[t.quality]
      return {
        video: 'libsvtav1',
        args: ['-preset', String(p.preset), '-crf', String(p.crf), '-g', String(g)],
        pixFmt: 'yuv420p',
        hardware: false,
      }
    }
  }
}

/** Tuned args for a hardware encoder by FFmpeg name (undefined if the family is unknown). */
export function hardwareEncoder(video: string, t: EncodeTarget): EncoderPick | undefined {
  if (video.endsWith('_amf')) return amf(video, t)
  if (video.endsWith('_nvenc')) return nvenc(video, t)
  if (video.endsWith('_qsv')) return qsv(video, t)
  if (video.endsWith('_videotoolbox')) return videotoolbox(video, t)
  return undefined
}

/**
 * Choose the encoder for an export: `cpu` → software; `auto`/`gpu` → the verified hardware
 * encoder for the codec when the toolchain has one, else software.
 */
export function pickEncoder(
  mode: ExportSettings['encoder'],
  hw: Toolchain['hwEncoders'],
  t: EncodeTarget,
): EncoderPick {
  if (mode !== 'cpu') {
    const name = hw[t.codec]
    const pick = name ? hardwareEncoder(name, t) : undefined
    if (pick) return pick
  }
  return cpuEncoder(t)
}
