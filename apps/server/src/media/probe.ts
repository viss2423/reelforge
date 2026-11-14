/**
 * ffprobe → normalised media description. `parseProbe` is pure (unit-tested against real
 * ffprobe output); `probeFile` runs ffprobe. Display dimensions (after rotation) are what
 * the editor/compiler work with because FFmpeg auto-rotates decoded frames.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Asset, AssetKind } from '@reelforge/core'
import type { DataPaths } from '../contracts.ts'
import { assetDir } from '../paths.ts'
import { run } from './ffmpeg.ts'

export type HdrKind = 'hlg' | 'pq'

/** Everything we learn from ffprobe. Persisted as `media/<id>/probe.json`. */
export interface MediaInfo {
  kind: AssetKind
  /** Microseconds; undefined for still images. */
  duration?: number
  /** Display size (rotation applied). */
  width?: number
  height?: number
  /** Coded size as stored in the bitstream. */
  codedWidth?: number
  codedHeight?: number
  /** Clockwise display rotation in degrees: 0, 90, 180 or 270. */
  rotation: number
  fps?: number
  /** Average frame rate as an exact rational ("30000/1001"). */
  fpsRational?: string
  /** Variable frame rate (phones record VFR; proxies are made CFR). */
  vfr: boolean
  videoStreamIndex?: number
  audioStreamIndex?: number
  videoCodec?: string
  audioCodec?: string
  pixFmt?: string
  bitDepth?: number
  colorTransfer?: string
  colorPrimaries?: string
  colorSpace?: string
  colorRange?: string
  hdr?: HdrKind
  hasVideo: boolean
  hasAudio: boolean
  audioChannels?: number
  audioSampleRate?: number
  /** First timestamp of the container, microseconds. */
  startTime: number
}

interface ProbeStream {
  index: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  bits_per_raw_sample?: string
  color_transfer?: string
  color_primaries?: string
  color_space?: string
  color_range?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  nb_frames?: string
  channels?: number
  sample_rate?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>
}

export interface ProbeJson {
  streams?: ProbeStream[]
  format?: { format_name?: string; duration?: string; start_time?: string }
}

const IMAGE_FORMATS =
  /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|jpegxl_pipe|avif|heif|svg_pipe|qoi_pipe|jpegls_pipe)(,|$)/
const IMAGE_CODECS = new Set([
  'mjpeg',
  'png',
  'webp',
  'bmp',
  'tiff',
  'jpegxl',
  'av1',
  'hevc',
  'qoi',
  'jpegls',
  'svg',
])

const rational = (s: string | undefined): number | undefined => {
  if (!s) return undefined
  const [n, d] = s.split('/').map(Number)
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  const v = d === undefined ? n : d > 0 ? n / d : NaN
  return Number.isFinite(v) && v > 0 ? v : undefined
}

const seconds = (s: string | undefined): number | undefined => {
  const n = s === undefined ? NaN : Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : undefined
}

/** Clockwise rotation from the display matrix (or the legacy `rotate` tag), snapped to 90°. */
export const streamRotation = (s: ProbeStream): number => {
  const matrix = s.side_data_list?.find((d) => typeof d.rotation === 'number')
  // The display-matrix angle is counter-clockwise; the legacy tag is clockwise.
  const deg = matrix ? -matrix.rotation! : Number(s.tags?.rotate ?? 0)
  const snapped = Math.round((Number.isFinite(deg) ? deg : 0) / 90) * 90
  return ((snapped % 360) + 360) % 360
}

const hdrOf = (transfer: string | undefined): HdrKind | undefined =>
  transfer === 'arib-std-b67' ? 'hlg' : transfer === 'smpte2084' ? 'pq' : undefined

const bitDepthOf = (s: ProbeStream): number | undefined => {
  const raw = Number(s.bits_per_raw_sample)
  if (Number.isFinite(raw) && raw > 0) return raw
  // High-bit-depth pixel formats always carry an endianness suffix (yuv420p10le, p010le).
  const m = /(\d{2})(?:le|be)$/.exec(s.pix_fmt ?? '')
  return m?.[1] ? Number(m[1]) : s.pix_fmt ? 8 : undefined
}

/** Normalises ffprobe JSON. `mime` is a hint used for still-image detection (e.g. HEIC). */
export const parseProbe = (json: ProbeJson, mime = ''): MediaInfo => {
  const streams = json.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find((s) => s.codec_type === 'audio')
  const formatName = json.format?.format_name ?? ''
  if (!video && !audio) throw new Error('no audio or video streams found')

  const durationUs = seconds(json.format?.duration) ?? seconds(video?.duration ?? audio?.duration)
  const isImage =
    video !== undefined &&
    (IMAGE_FORMATS.test(formatName) ||
      (mime.startsWith('image/') && IMAGE_CODECS.has(video.codec_name ?? '')) ||
      (!audio && video.nb_frames === '1' && (durationUs === undefined || durationUs <= 50_000)))
  const kind: AssetKind = video ? (isImage ? 'image' : 'video') : 'audio'

  const info: MediaInfo = {
    kind,
    rotation: 0,
    vfr: false,
    hasVideo: kind === 'video',
    hasAudio: audio !== undefined && kind !== 'image',
    startTime: seconds(json.format?.start_time) ?? 0,
  }
  if (kind !== 'image' && durationUs !== undefined) info.duration = durationUs

  if (video) {
    const rotation = streamRotation(video)
    const w = video.width ?? 0
    const h = video.height ?? 0
    const swap = rotation === 90 || rotation === 270
    Object.assign(info, {
      rotation,
      codedWidth: w,
      codedHeight: h,
      width: swap ? h : w,
      height: swap ? w : h,
      videoStreamIndex: video.index,
      videoCodec: video.codec_name,
      pixFmt: video.pix_fmt,
    })
    const depth = bitDepthOf(video)
    if (depth !== undefined) info.bitDepth = depth
    if (video.color_transfer) info.colorTransfer = video.color_transfer
    if (video.color_primaries) info.colorPrimaries = video.color_primaries
    if (video.color_space) info.colorSpace = video.color_space
    if (video.color_range) info.colorRange = video.color_range
    const hdr = hdrOf(video.color_transfer)
    if (hdr) info.hdr = hdr
    if (kind === 'video') {
      const avg = rational(video.avg_frame_rate)
      const real = rational(video.r_frame_rate)
      const fps = avg ?? real
      if (fps !== undefined) {
        info.fps = Math.round(fps * 1000) / 1000
        info.fpsRational = avg !== undefined ? video.avg_frame_rate : video.r_frame_rate
      }
      // r_frame_rate is the lowest rate that represents all timestamps; when the average
      // differs noticeably the stream has variable frame timing.
      info.vfr = avg !== undefined && real !== undefined && Math.abs(avg - real) / real > 0.005
    }
  }
  if (audio && kind !== 'image') {
    info.audioStreamIndex = audio.index
    if (audio.codec_name) info.audioCodec = audio.codec_name
    if (audio.channels) info.audioChannels = audio.channels
    const sr = Number(audio.sample_rate)
    if (Number.isFinite(sr) && sr > 0) info.audioSampleRate = sr
  }
  return info
}

/** Asset fields derived from probe info. */
export const assetFieldsFromInfo = (info: MediaInfo): Partial<Asset> => {
  const out: Partial<Asset> = {
    kind: info.kind,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo,
    rotation: info.rotation,
  }
  if (info.duration !== undefined) out.duration = info.duration
  if (info.width !== undefined) out.width = info.width
  if (info.height !== undefined) out.height = info.height
  if (info.fps !== undefined) out.fps = info.fps
  if (info.videoCodec !== undefined && info.kind === 'video') out.videoCodec = info.videoCodec
  if (info.audioCodec !== undefined) out.audioCodec = info.audioCodec
  if (info.kind === 'video') {
    if (info.colorTransfer !== undefined) out.colorTransfer = info.colorTransfer
    if (info.colorPrimaries !== undefined) out.colorPrimaries = info.colorPrimaries
  }
  return out
}

/** Runs ffprobe on a file and parses it. */
export const probeFile = async (
  ffprobe: string,
  file: string,
  opts: { mime?: string; signal?: AbortSignal } = {},
): Promise<MediaInfo> => {
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
    { captureStdout: true, timeoutMs: 60_000, ...(opts.signal ? { signal: opts.signal } : {}) },
  )
  return parseProbe(JSON.parse(stdout.toString('utf8')) as ProbeJson, opts.mime)
}

/** Sidecar file holding the full MediaInfo (HDR/VFR/colour details not in the Asset model). */
export const mediaInfoFile = (paths: DataPaths, assetId: string): string =>
  path.join(assetDir(paths, assetId), 'probe.json')

export const writeMediaInfo = async (
  paths: DataPaths,
  assetId: string,
  info: MediaInfo,
): Promise<void> => {
  const file = mediaInfoFile(paths, assetId)
  await writeFile(`${file}.part`, JSON.stringify(info))
  await rename(`${file}.part`, file)
}

export const readMediaInfo = async (paths: DataPaths, assetId: string): Promise<MediaInfo> =>
  JSON.parse(await readFile(mediaInfoFile(paths, assetId), 'utf8')) as MediaInfo
