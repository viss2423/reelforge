/**
 * FFmpeg process utilities for the render pipeline: spawning with argv arrays (never a
 * shell), cancellation, a bounded stderr ring buffer for error messages, and a streaming
 * parser for `-progress pipe:1` output.
 */
import { spawn } from 'node:child_process'

/** Keeps the last `capacity` characters of a stream (error context without unbounded memory). */
export class RingBuffer {
  readonly #capacity: number
  #chunks: string[] = []
  #size = 0

  constructor(capacity: number) {
    this.#capacity = capacity
  }

  push(text: string): void {
    if (text.length === 0) return
    this.#chunks.push(text)
    this.#size += text.length
    while (this.#size > this.#capacity) {
      const first = this.#chunks[0]!
      const excess = this.#size - this.#capacity
      if (first.length <= excess) {
        this.#chunks.shift()
        this.#size -= first.length
      } else {
        this.#chunks[0] = first.slice(excess)
        this.#size -= excess
      }
    }
  }

  toString(): string {
    return this.#chunks.join('')
  }
}

/** One `-progress` report (emitted at every `progress=continue|end` line). */
export interface FfmpegProgress {
  /** Output timestamp reached (us); undefined until FFmpeg knows it. */
  outTimeUs: number | undefined
  frame: number | undefined
  fps: number | undefined
  /** Encoding speed relative to realtime (e.g. 2.4 for "2.4x"). */
  speed: number | undefined
  done: boolean
}

const numberOr = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const v = Number.parseFloat(raw)
  return Number.isFinite(v) ? v : undefined
}

/**
 * Incremental parser for FFmpeg's `-progress` key=value stream. Feed it arbitrary chunks;
 * it invokes `onReport` once per complete block.
 */
export class ProgressParser {
  readonly #onReport: (p: FfmpegProgress) => void
  #partial = ''
  #fields = new Map<string, string>()

  constructor(onReport: (p: FfmpegProgress) => void) {
    this.#onReport = onReport
  }

  push(chunk: string): void {
    const text = this.#partial + chunk
    let start = 0
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      this.#line(text.slice(start, nl).trim())
      start = nl + 1
    }
    this.#partial = text.slice(start)
  }

  #line(line: string): void {
    const eq = line.indexOf('=')
    if (eq <= 0) return
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1).trim()
    if (key !== 'progress') {
      this.#fields.set(key, value)
      return
    }
    const f = this.#fields
    // out_time_us is "N/A" before the first packet; out_time_ms is (historically) also us.
    const outTime = numberOr(f.get('out_time_us')) ?? numberOr(f.get('out_time_ms'))
    const speedRaw = f.get('speed')
    this.#onReport({
      outTimeUs: outTime !== undefined && outTime >= 0 ? Math.round(outTime) : undefined,
      frame: numberOr(f.get('frame')),
      fps: numberOr(f.get('fps')),
      speed: speedRaw ? numberOr(speedRaw.replace(/x$/, '')) : undefined,
      done: value === 'end',
    })
    this.#fields = new Map()
  }
}

/** FFmpeg exited with an error; `message` carries the most relevant stderr lines. */
export class FfmpegError extends Error {
  readonly exitCode: number | null
  readonly stderr: string
  constructor(exitCode: number | null, stderr: string) {
    super(`ffmpeg failed (exit ${exitCode ?? 'signal'}): ${summarizeStderr(stderr)}`)
    this.name = 'FfmpegError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/** The run was cancelled through its AbortSignal. */
export class FfmpegAbortError extends Error {
  constructor() {
    super('ffmpeg cancelled')
    this.name = 'AbortError'
  }
}

/** Last few non-empty stderr lines, which is where FFmpeg reports the actual failure. */
export function summarizeStderr(stderr: string, lines = 6): string {
  const tail = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-lines)
  return tail.length > 0 ? tail.join(' | ') : 'no error output'
}

export interface RunFfmpegOptions {
  /** FFmpeg binary path. */
  bin: string
  args: readonly string[]
  signal?: AbortSignal
  /** Receives `-progress pipe:1` reports (add `-progress pipe:1 -nostats` to args). */
  onProgress?: (p: FfmpegProgress) => void
  /** Bytes of stderr kept for errors and for callers that parse it (default 64 KiB). */
  stderrLimit?: number
}

export interface RunFfmpegResult {
  /** Tail of stderr (bounded by `stderrLimit`). */
  stderr: string
}

/**
 * Run FFmpeg to completion. Rejects with {@link FfmpegError} on a non-zero exit and with
 * {@link FfmpegAbortError} when `signal` aborts (the process is killed first).
 */
export function runFfmpeg(o: RunFfmpegOptions): Promise<RunFfmpegResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new FfmpegAbortError())
      return
    }
    const child = spawn(o.bin, o.args, {
      stdio: ['ignore', o.onProgress ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true,
    })
    const stderr = new RingBuffer(o.stderrLimit ?? 64 * 1024)
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (d: string) => stderr.push(d))
    if (o.onProgress && child.stdout) {
      const parser = new ProgressParser(o.onProgress)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => parser.push(d))
    }
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      child.kill('SIGKILL')
    }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (err) => {
      o.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.once('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort)
      if (aborted) reject(new FfmpegAbortError())
      else if (code === 0) resolve({ stderr: stderr.toString() })
      else reject(new FfmpegError(code, stderr.toString()))
    })
  })
}

/** Loudness measured by `loudnorm=print_format=json` (FFmpeg prints strings). */
export interface LoudnormJson {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/**
 * Extract the loudnorm measurement from stderr: the last `{ … }` block containing
 * `input_i`. Returns undefined when absent or not finite (e.g. digital silence → "-inf").
 */
export function parseLoudnorm(
  stderr: string,
): { I: number; TP: number; LRA: number; thresh: number; offset: number } | undefined {
  const end = stderr.lastIndexOf('}')
  const start = end === -1 ? -1 : stderr.lastIndexOf('{', end)
  if (start === -1) return undefined
  let json: Partial<LoudnormJson>
  try {
    json = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnormJson>
  } catch {
    return undefined
  }
  const m = {
    I: Number(json.input_i),
    TP: Number(json.input_tp),
    LRA: Number(json.input_lra),
    thresh: Number(json.input_thresh),
    offset: Number(json.target_offset),
  }
  return Object.values(m).every(Number.isFinite) ? m : undefined
}
