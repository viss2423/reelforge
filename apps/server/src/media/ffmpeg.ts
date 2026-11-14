/**
 * Thin, allocation-conscious wrappers around FFmpeg/FFprobe child processes:
 * - no shell (argv only), hidden window on Windows,
 * - cancellation through AbortSignal (process tree killed),
 * - live progress from `-progress pipe:1` (out_time_us / speed),
 * - only the tail of stderr is retained for error messages (FFmpeg can be very chatty).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'

const STDERR_TAIL = 8 * 1024

export class FfmpegError extends Error {
  readonly code: number | null
  readonly stderr: string
  constructor(message: string, code: number | null, stderr: string) {
    super(message)
    this.name = 'FfmpegError'
    this.code = code
    this.stderr = stderr
  }
}

export interface FfmpegProgress {
  /** Output timestamp reached, microseconds. */
  outTimeUs: number
  /** Encoding speed relative to realtime (e.g. 4.2 = 4.2x), if known. */
  speed?: number
}

export interface RunOptions {
  signal?: AbortSignal
  /** Called for every progress block when `-progress pipe:1` is part of the args. */
  onProgress?: (p: FfmpegProgress) => void
  /** Hard timeout (ms); the process is killed and the promise rejects. */
  timeoutMs?: number
  /** Run below normal priority so interactive work (UI, preview) stays smooth. */
  lowPriority?: boolean
  /** Collect stdout as a Buffer (ffprobe JSON, small outputs). */
  captureStdout?: boolean
  /** Stream stdout to a consumer instead (e.g. PCM decoding). Mutually exclusive with capture. */
  onStdout?: (chunk: Buffer) => void
}

export interface RunResult {
  stdout: Buffer
  stderr: string
}

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')

/** Appends to a bounded tail buffer. */
const appendTail = (tail: string, chunk: Buffer): string => {
  const next = tail + chunk.toString('utf8')
  return next.length > STDERR_TAIL ? next.slice(-STDERR_TAIL) : next
}

const parseProgressBlock = (block: string, onProgress: (p: FfmpegProgress) => void): void => {
  let outTimeUs = -1
  let speed: number | undefined
  for (const line of block.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1).trim()
    if (key === 'out_time_us' || key === 'out_time_ms') {
      // out_time_ms is (historically) also microseconds.
      const n = Number(value)
      if (Number.isFinite(n)) outTimeUs = n
    } else if (key === 'speed') {
      const n = Number.parseFloat(value)
      if (Number.isFinite(n)) speed = n
    }
  }
  if (outTimeUs >= 0) onProgress(speed === undefined ? { outTimeUs } : { outTimeUs, speed })
}

const kill = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.killed) return
  // On Windows SIGKILL maps to TerminateProcess; elsewhere give FFmpeg no chance to linger.
  child.kill('SIGKILL')
}

/** Runs a tool to completion. Rejects with FfmpegError on non-zero exit, or the abort reason. */
export const run = (
  bin: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const { signal } = opts
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const wantsStdout = Boolean(opts.captureStdout || opts.onStdout || opts.onProgress)
    const child = spawn(bin, args, {
      stdio: ['ignore', wantsStdout ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true,
    })
    if (opts.lowPriority && child.pid !== undefined) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        // not permitted on this platform/user — run at normal priority
      }
    }
    let stderr = ''
    const chunks: Buffer[] = []
    let progressBuf = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (err: Error | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve({ stdout: Buffer.concat(chunks), stderr })
    }
    const onAbort = (): void => {
      kill(child)
      finish(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        kill(child)
        finish(new FfmpegError(`${bin} timed out after ${opts.timeoutMs} ms`, null, stderr))
      }, opts.timeoutMs)
    }

    child.stderr!.on('data', (c: Buffer) => {
      stderr = appendTail(stderr, c)
    })
    if (child.stdout) {
      child.stdout.on('data', (c: Buffer) => {
        if (opts.onStdout) opts.onStdout(c)
        else if (opts.onProgress) {
          progressBuf += c.toString('latin1')
          let end: number
          // Each progress block ends with a "progress=continue|end" line.
          while ((end = progressBuf.indexOf('progress=')) >= 0) {
            const nl = progressBuf.indexOf('\n', end)
            if (nl < 0) break
            parseProgressBlock(progressBuf.slice(0, nl), opts.onProgress)
            progressBuf = progressBuf.slice(nl + 1)
          }
        } else chunks.push(c)
      })
    }
    child.once('error', (err) => finish(err))
    child.once('close', (code) => {
      if (code === 0) finish(undefined)
      else {
        const lastLine = stderr.trim().split('\n').slice(-3).join(' | ')
        finish(new FfmpegError(`${bin} exited with code ${code}: ${lastLine}`, code, stderr))
      }
    })
  })

/** Common leading FFmpeg arguments: quiet, non-interactive, overwrite. */
export const FFMPEG_BASE: readonly string[] = [
  '-hide_banner',
  '-nostdin',
  '-y',
  '-loglevel',
  'error',
]
