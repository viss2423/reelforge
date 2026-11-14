/**
 * Editing proxies: ≤ 960 px on the long side, H.264 yuv420p, GOP 15 without B-frames (every
 * half second is a keyframe → instant seeking/scrubbing on phones), AAC 128k 48 kHz stereo,
 * `+faststart`, HDR tone-mapped to SDR BT.709, rotation baked in, VFR made CFR.
 *
 * Measured on the reference host (Ryzen 7 8840U / 780M): 1080×1920 H.264 → ~6.5× realtime;
 * 2160×3840 HEVC 10-bit HLG → ~1.5× realtime (decode-bound; hardware decode is used for
 * sources above 1080p where it measurably helps — for 1080p the frame download costs more
 * than software decoding saves).
 */
import { rename, rm } from 'node:fs/promises'
import type { Toolchain } from '../contracts.ts'
import { FFMPEG_BASE, run } from './ffmpeg.ts'
import { BT709_TAGS, fitEven, proxyEncoders, tonemapFilter, type VideoEncoder } from './filters.ts'
import type { MediaInfo } from './probe.ts'

export const PROXY_MAX_LONG_SIDE = 960
/** Pixel count above which hardware decoding pays off (see module docs). */
const HW_DECODE_MIN_PIXELS = 1920 * 1080 * 1.5

/** Toolchain with the optional platform extras detected by src/toolchain.ts. */
export type ToolchainExtras = Toolchain & { hwDecode?: string }

/** Builds the FFmpeg argv for a proxy encode with `encoder`. Pure (unit-tested). */
export const proxyArgs = (
  info: MediaInfo,
  input: string,
  output: string,
  encoder: VideoEncoder,
  hwDecode?: string,
): string[] => {
  if (info.videoStreamIndex === undefined || !info.width || !info.height)
    throw new Error('proxy requires a video stream')
  const size = fitEven(info.width, info.height, PROXY_MAX_LONG_SIDE)
  const tonemap = tonemapFilter(info)
  const vf = [
    `scale=${size.width}:${size.height}:flags=bilinear`,
    tonemap,
    'format=yuv420p',
    'setsar=1',
  ]
    .filter(Boolean)
    .join(',')
  const args = [...FFMPEG_BASE]
  if (hwDecode && info.width * info.height >= HW_DECODE_MIN_PIXELS) args.push('-hwaccel', hwDecode)
  args.push('-i', input, '-map', `0:${info.videoStreamIndex}`)
  if (info.audioStreamIndex !== undefined) args.push('-map', `0:${info.audioStreamIndex}`)
  args.push('-vf', vf, ...encoder.args)
  if (tonemap) args.push(...BT709_TAGS)
  // Constant frame rate for predictable seeking; cap high-speed footage at 60 fps.
  const fps = info.fps ?? 30
  if (fps > 60) args.push('-fps_mode', 'cfr', '-r', '60')
  else if (info.vfr && info.fpsRational) args.push('-fps_mode', 'cfr', '-r', info.fpsRational)
  if (info.audioStreamIndex !== undefined)
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  args.push(
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  )
  return args
}

export interface ProxyResult {
  encoder: string
  width: number
  height: number
}

/**
 * Encodes the proxy to `output` atomically (temp file + rename). Tries the verified GPU
 * encoder first and falls back to libx264 if it fails at runtime (driver hiccup, sessions
 * exhausted by a concurrent export).
 */
export const makeProxy = async (opts: {
  tools: ToolchainExtras
  info: MediaInfo
  input: string
  output: string
  signal: AbortSignal
  onProgress?: (fraction: number, etaUs?: number) => void
}): Promise<ProxyResult> => {
  const { tools, info, input, output, signal, onProgress } = opts
  const part = `${output}.part`
  const duration = info.duration ?? 0
  const encoders = proxyEncoders(tools)
  let lastError: unknown
  for (const encoder of encoders) {
    try {
      await run(tools.ffmpeg, proxyArgs(info, input, part, encoder, tools.hwDecode), {
        signal,
        lowPriority: true,
        onProgress: ({ outTimeUs, speed }) => {
          if (!onProgress || duration <= 0) return
          const fraction = Math.min(1, outTimeUs / duration)
          const eta = speed && speed > 0 ? (duration - outTimeUs) / speed : undefined
          onProgress(fraction, eta)
        },
      })
      await rename(part, output)
      return { encoder: encoder.name, ...fitEven(info.width!, info.height!, PROXY_MAX_LONG_SIDE) }
    } catch (err) {
      await rm(part, { force: true })
      if (signal.aborted) throw err
      lastError = err
    }
  }
  throw lastError
}
