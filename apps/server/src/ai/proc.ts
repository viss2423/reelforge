/**
 * Child-process helpers shared by the AI jobs: cancellation via AbortSignal, line-oriented
 * stderr parsing, bounded diagnostic tails and raw stdout streaming (no buffering).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** Thrown when a job's AbortSignal fires; the queue maps it to `cancelled`. */
export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message)
    this.name = 'AbortError'
  }
}

/** Throws a CancelledError if the signal is aborted. */
export const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new CancelledError()
}

export interface RunOptions {
  signal?: AbortSignal
  cwd?: string
  /** Called for every complete stderr line (without the newline). */
  onStderrLine?: (line: string) => void
  /** Called for every complete stdout line. Mutually exclusive with `onStdoutData`. */
  onStdoutLine?: (line: string) => void
  /**
   * Raw stdout consumer. Return a promise to apply backpressure: stdout is paused until it
   * settles, so a slow consumer (e.g. ONNX inference) never makes us buffer a whole video.
   */
  onStdoutData?: (chunk: Buffer) => void | Promise<void>
  /** Number of trailing stderr lines kept for error messages. */
  tailLines?: number
}

export interface RunResult {
  code: number
  /** Last `tailLines` lines of stderr (diagnostics). */
  stderrTail: string[]
}

/** Error carrying the exit code and the stderr tail of a failed tool run. */
export class ToolError extends Error {
  readonly code: number | null
  readonly stderrTail: string[]
  constructor(tool: string, code: number | null, tail: string[]) {
    const detail = tail
      .filter((l) => l.trim())
      .slice(-6)
      .join('\n')
    super(`${tool} failed (exit ${String(code)})${detail ? `:\n${detail}` : ''}`)
    this.name = 'ToolError'
    this.code = code
    this.stderrTail = tail
  }
}

/** Split a byte stream into lines (handles \r progress redraws and multi-byte UTF-8). */
const lineSplitter = (
  onLine: (line: string) => void,
): ((chunk: Buffer) => void) & {
  flush(): void
} => {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const push = (chunk: Buffer): void => {
    pending += decoder.write(chunk)
    let start = 0
    for (let i = 0; i < pending.length; i++) {
      const c = pending.charCodeAt(i)
      if (c === 10 || c === 13) {
        if (i > start) onLine(pending.slice(start, i))
        start = i + 1
      }
    }
    pending = pending.slice(start)
  }
  return Object.assign(push, {
    flush(): void {
      pending += decoder.end()
      if (pending) onLine(pending)
      pending = ''
    },
  })
}

/** Kill a child (and on Windows its whole tree, so whisper's worker threads die too). */
const kill = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => child.kill())
  } else {
    child.kill('SIGKILL')
  }
}

/**
 * Run `cmd args`, streaming its output to the given callbacks. Resolves with the exit code
 * (non-zero codes do NOT reject — callers decide); rejects with CancelledError on abort and
 * with the spawn error if the binary cannot be started.
 */
export const run = (
  cmd: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> =>
  new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CancelledError())
      return
    }
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', opts.onStdoutData || opts.onStdoutLine ? 'pipe' : 'ignore', 'pipe'],
    })
    const tailMax = opts.tailLines ?? 40
    const tail: string[] = []
    const errLines = lineSplitter((line) => {
      tail.push(line)
      if (tail.length > tailMax) tail.shift()
      opts.onStderrLine?.(line)
    })
    child.stderr?.on('data', errLines)

    let consumerError: unknown
    // The consumer's last chunk may still be processing when the child exits: `close`
    // waits for it so callers never see a result before all output was consumed.
    let inFlight: Promise<unknown> = Promise.resolve()
    if (opts.onStdoutData && child.stdout) {
      const out = child.stdout
      const consume = opts.onStdoutData
      // Pulled one chunk at a time: the next read waits for the consumer. (Not pause() in a
      // 'data' handler: when the child exits Node resumes such streams, and a chunk would
      // then arrive while the previous one is still being consumed.)
      inFlight = (async () => {
        try {
          for await (const chunk of out) await consume(chunk as Buffer)
        } catch (err) {
          // Leaving the loop destroys stdout; stop the producer too.
          consumerError ??= err
          kill(child)
        }
      })()
    } else if (opts.onStdoutLine && child.stdout) {
      child.stdout.on('data', lineSplitter(opts.onStdoutLine))
    }

    const onAbort = (): void => kill(child)
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.once('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.once('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      errLines.flush()
      void inFlight.then(() => {
        if (opts.signal?.aborted) reject(new CancelledError())
        else if (consumerError !== undefined) reject(consumerError as Error)
        else resolve({ code: code ?? -1, stderrTail: tail })
      })
    })
  })

/** Like `run` but rejects with a ToolError on a non-zero exit code. */
export const runChecked = async (
  tool: string,
  cmd: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> => {
  const r = await run(cmd, args, opts)
  if (r.code !== 0) throw new ToolError(tool, r.code, r.stderrTail)
  return r
}
