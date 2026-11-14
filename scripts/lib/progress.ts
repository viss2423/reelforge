/**
 * Terminal progress bars and tables for the bootstrap script. Rendering is throttled so a
 * fast download never spends measurable time writing to the console.
 */

export interface ProgressOptions {
  label: string
  /** Total bytes, if known. */
  total?: number
  /** Output stream (defaults to stderr so stdout stays machine-readable). */
  stream?: NodeJS.WriteStream
  /** Minimum ms between redraws on a TTY. */
  intervalMs?: number
}

const MB = 1024 * 1024

export const formatBytes = (n: number): string => {
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(2)} GB`
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

/** Render one progress line (pure; exported for tests). */
export const renderBar = (
  label: string,
  done: number,
  total: number | undefined,
  bytesPerSec: number,
  width = 24,
): string => {
  const speed = `${formatBytes(bytesPerSec)}/s`
  if (!total) return `${label}  ${formatBytes(done)}  ${speed}`
  const frac = Math.min(1, done / total)
  const filled = Math.round(frac * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const eta = bytesPerSec > 0 ? formatDuration((total - done) / bytesPerSec) : '--'
  return `${label}  ${bar} ${(frac * 100).toFixed(1).padStart(5)}%  ${formatBytes(done)}/${formatBytes(total)}  ${speed}  ETA ${eta}`
}

/**
 * Byte-progress reporter. On a TTY it redraws a single line; otherwise (CI logs) it prints a
 * line every 10 %, so logs stay short.
 */
export class Progress {
  readonly #label: string
  readonly #stream: NodeJS.WriteStream
  readonly #interval: number
  readonly #started = performance.now()
  #total: number | undefined
  #done = 0
  #base = 0
  #lastDraw = 0
  #lastDecile = -1

  constructor(opts: ProgressOptions) {
    this.#label = opts.label
    this.#total = opts.total
    this.#stream = opts.stream ?? process.stderr
    this.#interval = opts.intervalMs ?? 100
  }

  /** Bytes that were already present (resume) — excluded from the speed estimate. */
  setBase(bytes: number, total?: number): void {
    this.#base = bytes
    this.#done = bytes
    if (total !== undefined) this.#total = total
  }

  tick(bytes: number): void {
    this.#done += bytes
    const now = performance.now()
    if (this.#stream.isTTY) {
      if (now - this.#lastDraw < this.#interval) return
      this.#lastDraw = now
      this.#stream.write(`\r${this.#line(now)}\u001b[K`)
    } else if (this.#total) {
      const decile = Math.floor((this.#done / this.#total) * 10)
      if (decile > this.#lastDecile) {
        this.#lastDecile = decile
        this.#stream.write(`${this.#line(now)}\n`)
      }
    }
  }

  done(note = ''): void {
    const line = this.#line(performance.now())
    if (this.#stream.isTTY) this.#stream.write(`\r${line}${note ? `  ${note}` : ''}\u001b[K\n`)
    else if (note) this.#stream.write(`${this.#label}  ${note}\n`)
  }

  #line(now: number): string {
    const secs = Math.max(1e-3, (now - this.#started) / 1000)
    return renderBar(this.#label, this.#done, this.#total, (this.#done - this.#base) / secs)
  }
}

/** Plain-text table with padded columns (used for the setup summary). */
export const formatTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd()
  return [line(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}
