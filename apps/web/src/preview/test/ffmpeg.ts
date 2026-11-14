/**
 * Test helpers that generate media fixtures with FFmpeg's lavfi sources (no binary fixtures
 * in git). Every helper is gated on FFmpeg being on PATH; tests use `describe.skipIf(!HAS_FFMPEG)`
 * and print why they were skipped.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const probe = (bin: string): boolean => {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0
  } catch {
    return false
  }
}

export const HAS_FFMPEG = probe('ffmpeg') && probe('ffprobe')

if (!HAS_FFMPEG) {
  console.warn('[preview tests] ffmpeg/ffprobe not found on PATH — FFmpeg-backed tests are skipped')
}

/** A temp directory removed by the returned cleanup function. */
export function tempDir(prefix = 'rf-preview-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function ffmpeg(args: readonly string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  })
}

/** Run ffmpeg and capture raw stdout bytes (use with `-f rawvideo pipe:1`). */
export function ffmpegRaw(args: readonly string[], cwd?: string): Buffer {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    cwd,
  })
}

export interface ProxyOptions {
  seconds?: number
  width?: number
  height?: number
  fps?: number
  gop?: number
  bframes?: number
  faststart?: boolean
  audio?: boolean
  codec?: 'libx264' | 'libx265'
  /** Display rotation metadata in degrees (counter-clockwise, as ffmpeg's -display_rotation). */
  rotation?: number
}

/**
 * Generate a proxy-like MP4 exactly as the server's proxy job does (H.264, GOP 15, no
 * B-frames, AAC, faststart) unless overridden.
 */
export function makeProxy(file: string, o: ProxyOptions = {}): string {
  const seconds = o.seconds ?? 3
  const fps = o.fps ?? 30
  const size = `${o.width ?? 540}x${o.height ?? 960}`
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`]
  if (o.audio !== false) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`)
  }
  args.push('-c:v', o.codec ?? 'libx264', '-preset', 'veryfast', '-g', String(o.gop ?? 15))
  if (o.codec === 'libx265') {
    args.push('-tag:v', 'hvc1', '-x265-params', `bframes=${o.bframes ?? 0}:log-level=error`)
  } else {
    args.push('-bf', String(o.bframes ?? 0))
  }
  args.push('-pix_fmt', 'yuv420p')
  if (o.audio !== false) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
  if (o.faststart !== false) args.push('-movflags', '+faststart')
  if (o.rotation) {
    const tmp = `${file}.norot.mp4`
    ffmpeg([...args, tmp])
    ffmpeg(['-display_rotation', String(o.rotation), '-i', tmp, '-c', 'copy', file])
    rmSync(tmp, { force: true })
  } else {
    ffmpeg([...args, file])
  }
  return file
}

export interface ProbedPacket {
  stream: number
  pts: number
  dts: number
  duration: number
  size: number
  pos: number
  key: boolean
}

/** ffprobe every packet (times in integer microseconds). */
export function probePackets(file: string): ProbedPacket[] {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'packet=stream_index,pts_time,dts_time,duration_time,size,pos,flags',
      '-of',
      'json',
      file,
    ],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  ).toString()
  const json = JSON.parse(out) as {
    packets: Array<{
      stream_index: number
      pts_time?: string
      dts_time?: string
      duration_time?: string
      size: string
      pos: string
      flags: string
    }>
  }
  const us = (s: string | undefined): number => Math.round(Number(s ?? 'NaN') * 1e6)
  return json.packets.map((p) => ({
    stream: p.stream_index,
    pts: us(p.pts_time),
    dts: us(p.dts_time),
    duration: us(p.duration_time),
    size: Number(p.size),
    pos: Number(p.pos),
    key: p.flags.startsWith('K'),
  }))
}

export const readBytes = (file: string): Uint8Array => new Uint8Array(readFileSync(file))
