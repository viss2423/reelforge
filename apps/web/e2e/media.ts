/**
 * FFmpeg/FFprobe helpers for asserting on real output: stream layout, loudness, and pixel
 * statistics of single frames (exported video or browser screenshots). No image libraries —
 * FFmpeg decodes everything to raw 8-bit gray.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE ?? 'ffprobe'

export interface ProbeResult {
  /** Container duration in seconds. */
  duration: number
  video?: { codec: string; width: number; height: number; fps: number }
  audio?: { codec: string; sampleRate: number; channels: number }
}

/** Streams and duration of a media file. */
export const probe = async (file: string): Promise<ProbeResult> => {
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels',
    '-of',
    'json',
    file,
  ])
  const json = JSON.parse(stdout) as {
    format: { duration: string }
    streams: Array<Record<string, string | number | undefined>>
  }
  const v = json.streams.find((s) => s.codec_type === 'video')
  const a = json.streams.find((s) => s.codec_type === 'audio')
  const rate = (r: unknown) => {
    const [n, d] = String(r).split('/').map(Number)
    return n && d ? n / d : 0
  }
  return {
    duration: Number(json.format.duration),
    ...(v && {
      video: {
        codec: String(v.codec_name),
        width: Number(v.width),
        height: Number(v.height),
        fps: rate(v.avg_frame_rate),
      },
    }),
    ...(a && {
      audio: {
        codec: String(a.codec_name),
        sampleRate: Number(a.sample_rate),
        channels: Number(a.channels),
      },
    }),
  }
}

/** Integrated loudness (EBU R128, LUFS) of a file's audio. */
export const integratedLoudness = async (file: string): Promise<number> => {
  // ebur128 prints its summary on stderr at the end of the run.
  const { stderr } = await run(
    FFMPEG,
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const m = /I:\s*(-?[\d.]+)\s*LUFS/.exec(summary)
  if (!m?.[1]) throw new Error(`no loudness summary in ffmpeg output:\n${stderr.slice(-800)}`)
  return Number(m[1])
}

/** A decoded 8-bit gray image. */
export interface GrayFrame {
  width: number
  height: number
  data: Buffer
}

const decodeGray = (args: string[], width: number, height: number, input?: Buffer) =>
  new Promise<GrayFrame>((resolve, reject) => {
    const p = spawn(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      ...args,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:${height}:flags=area,format=gray`,
      '-f',
      'rawvideo',
      '-',
    ])
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', (b: Buffer) => out.push(b))
    p.stderr.on('data', (b: Buffer) => (err += String(b)))
    p.on('error', reject)
    p.on('close', (code) => {
      const data = Buffer.concat(out)
      if (code !== 0 || data.length !== width * height)
        reject(new Error(`ffmpeg gray decode failed (${code}): ${err}`))
      else resolve({ width, height, data })
    })
    if (input) p.stdin.end(input)
  })

/** The video frame at `seconds` as gray pixels (scaled to `width`×`height`). */
export const grayFrameAt = (file: string, seconds: number, width = 1080, height = 1920) =>
  decodeGray(['-ss', seconds.toFixed(3), '-i', file], width, height)

/** A PNG (e.g. a Playwright screenshot) as gray pixels. */
export const grayPng = (png: Buffer, width: number, height: number) =>
  decodeGray(['-f', 'png_pipe', '-i', '-'], width, height, png)

/** Fraction (0..1) of pixels in rows [y0, y1) brighter than `threshold`. */
export const brightFraction = (f: GrayFrame, y0 = 0, y1 = f.height, threshold = 96): number => {
  const from = Math.max(0, Math.floor(y0)) * f.width
  const to = Math.min(f.height, Math.ceil(y1)) * f.width
  let n = 0
  for (let i = from; i < to; i++) if (f.data[i]! > threshold) n++
  return to > from ? n / (to - from) : 0
}
