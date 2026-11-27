/**
 * Matte encoder: one FFmpeg process reads raw 8-bit gray frames on stdin and writes both
 * outputs of the `matte` job in one pass:
 *
 * - `matte.mkv`  — FFV1 gray, full matte resolution, source frame rate: lossless, exact for
 *   export (the compiler decodes it in lockstep with the original).
 * - `matte-proxy.mp4` — the phone preview's mask: H.264 at the editing-proxy size (≤ 960 px),
 *   GOP 15, no B-frames, +faststart, like the media proxies so the preview's MP4 demuxer and
 *   WebCodecs path play it unchanged. Stills get a PNG instead.
 *
 * Frames are written with backpressure (`drain`), so a fast model never queues a video's
 * worth of masks in memory. Abort kills the process.
 */
import { spawn } from 'node:child_process'
import { fitEven } from '../../media/filters.ts'
import { PROXY_MAX_LONG_SIDE } from '../../media/proxy.ts'
import { CancelledError, ToolError } from '../proc.ts'

export interface MatteWriterOptions {
  ffmpeg: string
  width: number
  height: number
  /** Frame rate as FFmpeg accepts it (`30`, `30000/1001`). */
  fps: string
  /** Lossless export matte (.mkv). */
  output: string
  /** Preview mask (.mp4 for video, .png for a still). */
  proxy: string
  still: boolean
  signal?: AbortSignal
}

/** FFmpeg argv for the writer (pure; unit-tested). */
export const matteWriterArgs = (o: Omit<MatteWriterOptions, 'ffmpeg' | 'signal'>): string[] => {
  const p = fitEven(o.width, o.height, PROXY_MAX_LONG_SIDE)
  const input = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-s',
    `${o.width}x${o.height}`,
    '-r',
    o.fps,
    '-i',
    'pipe:0',
  ]
  const lossless = [
    '-map',
    '0:v',
    '-c:v',
    'ffv1',
    '-level',
    '3',
    '-pix_fmt',
    'gray',
    '-f',
    'matroska',
    o.output,
  ]
  const scale = `scale=${p.width}:${p.height}:flags=area`
  const proxy = o.still
    ? ['-map', '0:v', '-vf', scale, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'image2', o.proxy]
    : [
        '-map',
        '0:v',
        // Gray in limited-range BT.709 luma with neutral chroma: decoders return R = G = B = α.
        '-vf',
        `${scale},format=yuv420p`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '16',
        '-profile:v',
        'high',
        '-x264-params',
        'keyint=15:min-keyint=15:scenecut=0:bframes=0',
        '-color_range',
        'tv',
        '-colorspace',
        'bt709',
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        o.proxy,
      ]
  return [...input, ...lossless, ...proxy]
}

export interface MatteWriter {
  /** Queue one W×H gray frame; resolves when the pipe can take more. */
  write(frame: Uint8Array): Promise<void>
  /** Close stdin and wait for FFmpeg to finish both files. */
  end(): Promise<void>
  /** Kill the process (failed/cancelled job). */
  abort(): void
}

export const openMatteWriter = (o: MatteWriterOptions): MatteWriter => {
  const child = spawn(o.ffmpeg, matteWriterArgs(o), {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  const tail: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (s: string) => {
    for (const line of s.split(/\r?\n/)) if (line.trim()) tail.push(line)
    if (tail.length > 40) tail.splice(0, tail.length - 40)
  })
  let spawnError: Error | undefined
  const done = new Promise<number>((resolve) => {
    child.once('error', (err) => {
      spawnError = err
      resolve(-1)
    })
    child.once('close', (code) => resolve(code ?? -1))
  })
  // Write errors (EPIPE after FFmpeg died) surface through the exit code instead.
  child.stdin.on('error', () => undefined)
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const onAbort = (): void => kill()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  const fail = async (): Promise<never> => {
    const code = await done
    if (o.signal?.aborted) throw new CancelledError()
    throw spawnError ?? new ToolError('ffmpeg', code, tail)
  }
  return {
    async write(frame) {
      if (o.signal?.aborted) throw new CancelledError()
      if (child.exitCode !== null || spawnError) return fail()
      if (child.stdin.write(frame)) return
      await new Promise<void>((resolve) => {
        const go = (): void => {
          child.stdin.off('drain', go)
          child.off('close', go)
          resolve()
        }
        child.stdin.on('drain', go)
        child.once('close', go)
      })
      if (child.exitCode !== null && child.exitCode !== 0) return fail()
    },
    async end() {
      child.stdin.end()
      const code = await done
      o.signal?.removeEventListener('abort', onAbort)
      if (o.signal?.aborted) throw new CancelledError()
      if (code !== 0) throw spawnError ?? new ToolError('ffmpeg', code, tail)
    },
    abort() {
      o.signal?.removeEventListener('abort', onAbort)
      kill()
    },
  }
}
