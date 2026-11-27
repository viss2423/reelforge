/**
 * Streaming frame source for the face detector: FFmpeg decodes (hardware-assisted when
 * available), samples at a fixed rate and downsizes, writing binary PPM images to a pipe.
 * PPM carries each frame's size in its header, so the rotated display size never has to be
 * predicted. Decoding runs ahead of inference by a bounded queue: the two overlap, yet
 * memory stays at a few frames.
 *
 * On Windows, frames stay in GPU memory (D3D11VA) until the `fps` filter has dropped the
 * ones we don't sample, so only ~1 in 6 frames crosses the bus. Measured on a Radeon 780M:
 * 60 s 1080p H.264 2.3 s vs 3.2–6.1 s when every frame is downloaded; 30 s 4K HEVC 4.1 s
 * vs 5.1 s (software decode: 12 s). FFmpeg cannot auto-rotate GPU frames, so the rotation
 * is probed and applied after the download; codecs D3D11VA cannot decode fall back to the
 * portable path.
 */
import { FF_HWACCEL, FF_PROGRESS, parseProgressLine } from '../media.ts'
import { run, ToolError, type RunResult } from '../proc.ts'

/** One decoded RGB24 frame. */
export interface RgbFrame {
  /** Sample index (0, 1, 2, …): frame time = index / fps. */
  index: number
  width: number
  height: number
  /** Packed RGB, `width·height·3` bytes; owned by the consumer. */
  data: Uint8Array
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09

/**
 * Incremental parser for a concatenated stream of binary PPM (P6, maxval ≤ 255) images.
 * Chunks may split headers and pixel data anywhere.
 */
export class PpmStreamParser {
  readonly #onFrame: (frame: RgbFrame) => void
  #header = ''
  #data: Uint8Array | undefined
  #filled = 0
  #width = 0
  #height = 0
  #count = 0

  constructor(onFrame: (frame: RgbFrame) => void) {
    this.#onFrame = onFrame
  }

  push(chunk: Uint8Array): void {
    let pos = 0
    while (pos < chunk.length) {
      if (this.#data) {
        const n = Math.min(chunk.length - pos, this.#data.length - this.#filled)
        this.#data.set(chunk.subarray(pos, pos + n), this.#filled)
        this.#filled += n
        pos += n
        if (this.#filled === this.#data.length) {
          this.#onFrame({
            index: this.#count++,
            width: this.#width,
            height: this.#height,
            data: this.#data,
          })
          this.#data = undefined
          this.#filled = 0
          this.#header = ''
        }
        continue
      }
      // Header: "P6" ws width ws height ws maxval, then exactly one whitespace byte.
      const c = chunk[pos++] ?? 0
      this.#header += String.fromCharCode(c)
      if (this.#header.length > 64) throw new Error('invalid PPM stream (header too long)')
      if (!isSpace(c)) continue
      const tokens = this.#header.trim().split(/\s+/)
      if (tokens.length < 4) continue
      const [magic, w, h, max] = tokens
      const width = Number(w)
      const height = Number(h)
      if (magic !== 'P6' || !(width > 0) || !(height > 0) || Number(max) !== 255) {
        throw new Error(`invalid PPM header: ${JSON.stringify(this.#header)}`)
      }
      this.#width = width
      this.#height = height
      this.#data = new Uint8Array(width * height * 3)
      this.#filled = 0
    }
  }

  /** Frames emitted so far. */
  get frames(): number {
    return this.#count
  }

  /** Throws if the stream ended inside a frame. */
  end(): void {
    if (this.#data || this.#header.trim()) throw new Error('PPM stream ended mid-frame')
  }
}

/**
 * Filters (with a trailing comma) applying a display-matrix rotation — degrees as ffprobe
 * reports it — exactly like FFmpeg's auto-rotation; undefined for non-right angles.
 */
export const rotationFilters = (rotation: number): string | undefined => {
  switch (((-Math.round(rotation) % 360) + 360) % 360) {
    case 0:
      return ''
    case 90:
      return 'transpose=clock,'
    case 180:
      return 'hflip,vflip,'
    case 270:
      return 'transpose=cclock,'
    default:
      return undefined
  }
}

/** Display rotation of the first video stream (0 when unrotated), undefined if probing failed. */
export const probeRotation = async (
  ffprobe: string,
  file: string,
  signal?: AbortSignal,
): Promise<number | undefined> => {
  let first = ''
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream_side_data=rotation',
    '-of',
    'csv=p=0',
    file,
  ]
  const r = await run(ffprobe, args, {
    ...(signal ? { signal } : {}),
    onStdoutLine: (line) => {
      first ||= line.trim()
    },
  }).catch((err: unknown) => {
    if (signal?.aborted) throw err
    return undefined
  })
  if (r?.code !== 0) return undefined
  const v = Number(first || 0)
  return Number.isFinite(v) ? v : undefined
}

export interface FrameStreamOptions {
  ffmpeg: string
  /** ffprobe binary: enables the GPU-resident sampling path on Windows. */
  ffprobe?: string
  file: string
  /** Samples per second; 0 = every decoded frame (no resampling; the only way to read a still). */
  fps: number
  /** Output width in px (height follows the display aspect ratio, even). */
  width: number
  signal?: AbortSignal
  /** Async frame consumer; at most `queue` decoded frames wait for it. */
  onFrame: (frame: RgbFrame) => Promise<void> | void
  onTime?: (us: number) => void
  /** Max frames decoded ahead of the consumer (default 3). */
  queue?: number
}

/** Decode `file` into sampled RGB frames, feeding them to `onFrame` in order. Resolves with the frame count. */
export const streamFrames = async (o: FrameStreamOptions): Promise<number> => {
  const max = o.queue ?? 3
  const queue: RgbFrame[] = []
  let wakeConsumer: (() => void) | undefined
  let releaseProducer: (() => void) | undefined
  let finished = false
  let failure: unknown
  let count = 0

  const consumer = (async () => {
    for (;;) {
      const frame = queue.shift()
      if (!frame) {
        if (finished) return
        await new Promise<void>((r) => (wakeConsumer = r))
        continue
      }
      releaseProducer?.()
      releaseProducer = undefined
      await o.onFrame(frame)
      count++
    }
  })()
  consumer.catch((err: unknown) => {
    failure ??= err
    releaseProducer?.()
  })

  const newParser = (): PpmStreamParser =>
    new PpmStreamParser((frame) => {
      queue.push(frame)
      wakeConsumer?.()
      wakeConsumer = undefined
    })
  let parser = newParser()

  // Area averaging keeps small faces crisp when shrinking 4K → 320 px.
  const scale = `scale=${o.width}:-2:flags=area,format=rgb24`
  const head = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', ...FF_PROGRESS]
  const tail = ['-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'ppm', '-f', 'image2pipe', 'pipe:1']
  const sample = o.fps > 0 ? `fps=${o.fps},` : ''
  const portable = [...head, ...FF_HWACCEL, '-i', o.file, '-vf', `${sample}${scale}`, ...tail]
  const rotation =
    process.platform === 'win32' && o.ffprobe
      ? await probeRotation(o.ffprobe, o.file, o.signal)
      : undefined
  const rotate = rotation === undefined ? undefined : rotationFilters(rotation)
  const gpuResident =
    rotate === undefined
      ? undefined
      : [
          ...head,
          '-noautorotate',
          '-hwaccel',
          'd3d11va',
          '-hwaccel_output_format',
          'd3d11',
          '-i',
          o.file,
          '-vf',
          `${sample}hwdownload,format=nv12|p010le,${rotate}${scale}`,
          ...tail,
        ]

  const decode = (args: readonly string[]): Promise<RunResult> =>
    run(o.ffmpeg, args, {
      ...(o.signal ? { signal: o.signal } : {}),
      onStderrLine: (line) => {
        const t = parseProgressLine(line)
        if (t !== undefined) o.onTime?.(t)
      },
      onStdoutData: (chunk) => {
        if (failure !== undefined) return Promise.reject(failure as Error)
        parser.push(chunk)
        if (queue.length < max) return undefined
        return new Promise<void>((resolve, reject) => {
          releaseProducer = () => (failure === undefined ? resolve() : reject(failure as Error))
        })
      },
    })

  let r: RunResult
  try {
    r = await decode(gpuResident ?? portable)
    // The GPU path failed before producing a frame (typically a codec D3D11VA can't decode,
    // so frames land in system memory and hwdownload rejects them): redo it portably.
    if (gpuResident && r.code !== 0 && parser.frames === 0) {
      parser = newParser()
      r = await decode(portable)
    }
  } catch (err) {
    // Cancelled or failed: drop pending frames so the consumer stops promptly.
    queue.length = 0
    throw err
  } finally {
    finished = true
    wakeConsumer?.()
    await consumer.catch(() => undefined)
  }
  if (failure !== undefined) throw failure as Error
  if (r.code !== 0) {
    if (r.stderrTail.some((l) => /matches no streams/i.test(l)))
      throw new Error('this media has no video track')
    throw new ToolError('ffmpeg', r.code, r.stderrTail)
  }
  parser.end()
  return count
}
