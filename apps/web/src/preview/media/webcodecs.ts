/**
 * Frame-accurate video source on WebCodecs.
 *
 * The proxy's sample table (see mp4.ts) tells us exactly which bytes form which frame, so
 * seeking is: reset → feed from the previous keyframe (≤ 14 frames with GOP 15) → flush →
 * show the frame whose timestamp equals the wanted frame's cts. During playback samples
 * are fed ahead of the clock so frames are ready before they are due.
 *
 * Memory: decoded VideoFrames pin decoder surfaces, and hardware decoders stall when too
 * many are held, so at most {@link HOLD} frames are kept and the rest are closed eagerly.
 *
 * Why the main thread: VideoDecoder already decodes off-thread (in the GPU/media process);
 * the JS here only slices bytes and enqueues chunks (~20 µs per frame). Moving it to a
 * Worker would add a VideoFrame transfer per frame and a second copy of the sample tables
 * for no measurable gain.
 */
import { frameRankAt, type Mp4Track, type SampleTable } from './mp4.ts'
import { planDecode, type DecodePlan, type DecodeRun } from './decodePlan.ts'
import type { MediaFile } from './mediaFile.ts'
import type { FrameHandle, MediaStats, PixelSource, SourceInfo } from './source.ts'

/** Max decoded frames held (display + read-ahead). */
const HOLD = 8
/** Frames decoded ahead of the display frame while playing. */
const AHEAD = 6
/**
 * Frames decoded past a paused seek target: makes the next frame-steps instant and gives
 * decoders that hold a frame back (reorder-free streams still do on some platforms) the
 * samples they need to emit the target without a flush.
 */
const STEP_AHEAD = 2
/** How long a paused seek waits for the target frame before flushing the decoder (ms). */
const OUTPUT_WAIT_MS = 12
/** Samples fetched per byte-range request beyond the wanted one (≈ two GOPs). */
const FETCH_SAMPLES = 30

interface ByteWindow {
  /** File offset of data[0]. */
  start: number
  data: Uint8Array
}

/** Is WebCodecs video decoding available in this browser? */
export const hasWebCodecs = (): boolean =>
  typeof globalThis.VideoDecoder === 'function' &&
  typeof globalThis.EncodedVideoChunk === 'function'

export class WebCodecsSource implements PixelSource {
  readonly kind = 'webcodecs'
  info: SourceInfo | undefined
  error: Error | undefined
  readonly #file: MediaFile
  readonly #stats: MediaStats
  #track: Mp4Track | undefined
  #samples: SampleTable | undefined
  #decoder: VideoDecoder | undefined
  #config: VideoDecoderConfig | undefined
  readonly #frames: VideoFrame[] = []
  readonly #run: DecodeRun = { runStart: -1, next: 0 }
  readonly #plan: DecodePlan = { reset: false, from: 0, to: -1 }
  #wantT = 0
  #playing = false
  #rate = 1
  #gen = 0
  #pumping = false
  #again = false
  #closed = false
  #bytes: ByteWindow | undefined
  #version = 0
  /** Timestamp of the latest output since the last reset (in-flight detection). */
  #lastOut = Number.NEGATIVE_INFINITY
  #waiter: { ts: number; resolve: () => void } | undefined
  readonly #heldAt = (i: number): boolean => this.#holds(this.#samples!.cts[i]!)
  readonly #handle = {
    image: null as unknown as TexImageSource,
    timestamp: 0,
    exact: false,
    version: 0,
  }

  constructor(file: MediaFile, stats: MediaStats) {
    this.#file = file
    this.#stats = stats
    void this.#open()
  }

  async #open(): Promise<void> {
    try {
      const info = await this.#file.info()
      const v = info.video
      if (!v || !v.codec) throw new Error('no decodable video track')
      const config: VideoDecoderConfig = {
        codec: v.codec,
        codedWidth: v.width,
        codedHeight: v.height,
        optimizeForLatency: false,
        ...(v.description ? { description: v.description } : {}),
      }
      const support = await VideoDecoder.isConfigSupported(config)
      if (!support.supported) throw new Error(`codec ${v.codec} not supported by VideoDecoder`)
      if (this.#closed) return
      this.#track = v
      this.#samples = v.samples
      this.#config = config
      this.#decoder = new VideoDecoder({
        output: (f) => this.#onFrame(f),
        error: (e) => this.#fail(e),
      })
      this.#decoder.configure(config)
      this.#stats.activeDecoders++
      this.info = { width: v.width, height: v.height, rotation: v.rotation, duration: v.duration }
      this.#pump()
    } catch (e) {
      this.#fail(e)
    }
  }

  #fail(e: unknown): void {
    this.error = e instanceof Error ? e : new Error(String(e))
    this.close()
  }

  want(t: number, playing: boolean, rate: number): void {
    if (t !== this.#wantT) this.#waiter?.resolve()
    this.#wantT = t
    this.#playing = playing
    this.#rate = rate
    if (this.#samples) this.#pump()
  }

  frame(t: number): FrameHandle | null {
    const s = this.#samples
    const frames = this.#frames
    if (!s || frames.length === 0) return null
    const target = s.cts[s.presentation[frameRankAt(s, t)]!]!
    // frames are sorted by timestamp: pick the exact one, else the latest at or before t
    let best: VideoFrame | undefined
    for (const f of frames) {
      if (f.timestamp <= target) best = f
      else break
    }
    best ??= frames[0]!
    const h = this.#handle
    if (h.image !== best) this.#version++
    h.image = best
    h.timestamp = best.timestamp
    h.exact = best.timestamp === target
    h.version = this.#version
    return h
  }

  #onFrame(f: VideoFrame): void {
    if (this.#closed) {
      f.close()
      return
    }
    this.#stats.framesDecoded++
    if (f.timestamp > this.#lastOut) this.#lastOut = f.timestamp
    const frames = this.#frames
    let i = frames.length
    while (i > 0 && frames[i - 1]!.timestamp > f.timestamp) i--
    if (i > 0 && frames[i - 1]!.timestamp === f.timestamp) {
      // a re-decode of a frame we already hold (seek within a GOP): keep the old one
      f.close()
    } else {
      frames.splice(i, 0, f)
    }
    this.#trim()
    if (this.#waiter && f.timestamp >= this.#waiter.ts) this.#waiter.resolve()
    if (this.#run.runStart >= 0) this.#pump()
  }

  /** Close frames that can no longer be shown; keep the display frame and read-ahead. */
  #trim(): void {
    const s = this.#samples
    const frames = this.#frames
    if (!s) return
    const display = s.cts[s.presentation[frameRankAt(s, this.#wantT)]!]!
    // drop frames before the display frame when moving forward (they are behind the clock)
    if (this.#rate >= 0) {
      while (frames.length > 1 && frames[1]!.timestamp <= display) frames.shift()!.close()
    }
    // cap: evict the frame farthest from the display time
    while (frames.length > HOLD) {
      const first = frames[0]!
      const last = frames[frames.length - 1]!
      const victim =
        Math.abs(first.timestamp - display) > Math.abs(last.timestamp - display)
          ? frames.shift()!
          : frames.pop()!
      victim.close()
    }
  }

  #holds(ts: number): boolean {
    for (const f of this.#frames) if (f.timestamp === ts) return true
    return false
  }

  /** Single-flight async loop: feed samples according to the current plan. */
  #pump(): void {
    if (this.#pumping) {
      this.#again = true
      return
    }
    this.#pumping = true
    void (async () => {
      try {
        do {
          this.#again = false
          await this.#step()
        } while (this.#again && !this.#closed)
      } catch (e) {
        if (!this.#closed && !(e instanceof DOMException && e.name === 'AbortError')) this.#fail(e)
      } finally {
        this.#pumping = false
      }
    })()
  }

  async #step(): Promise<void> {
    const s = this.#samples
    const dec = this.#decoder
    const cfg = this.#config
    if (!s || !dec || !cfg || this.#closed || dec.state === 'closed') return
    this.#trim()
    const target = s.presentation[frameRankAt(s, this.#wantT)]!
    const targetTs = s.cts[target]!
    const ahead = !this.#playing ? STEP_AHEAD : this.#rate < 0 ? 0 : AHEAD
    const plan = planDecode(s, this.#run, target, ahead, this.#heldAt, this.#lastOut, this.#plan)
    if (plan.reset) {
      dec.reset()
      dec.configure(cfg)
      this.#gen++
      this.#lastOut = Number.NEGATIVE_INFINITY
      this.#stats.decoderResets++
      this.#run.runStart = plan.from
      this.#run.next = plan.from
    }
    const gen = this.#gen
    for (let i = this.#run.next; i <= plan.to; i++) {
      // the wanted time moved while we were fetching: re-plan instead of finishing a stale run
      if (this.#again) return
      // back-pressure: let the decoder drain before queueing more
      if (this.#frames.length + dec.decodeQueueSize >= HOLD && this.#playing) return
      const data = await this.#sampleBytes(i)
      if (gen !== this.#gen || this.#closed) return
      dec.decode(
        new EncodedVideoChunk({
          type: s.key[i] ? 'key' : 'delta',
          timestamp: s.cts[i]!,
          duration: s.duration[i]!,
          data,
        }),
      )
      this.#run.next = i + 1
    }
    if (this.#holds(targetTs) || this.#run.next <= target) return
    // the target is in the decoder: while playing, read-ahead pushes it out
    if (this.#playing && this.#run.next < s.count) return
    // paused: most decoders emit it within a few ms once later samples are queued; only
    // flush (which forces the next run to restart at a keyframe) if it does not arrive
    await this.#outputOf(targetTs, OUTPUT_WAIT_MS)
    if (gen !== this.#gen || this.#closed || this.#holds(targetTs)) return
    if (s.presentation[frameRankAt(s, this.#wantT)] !== target) return // moved: re-plan
    await dec.flush()
    if (gen === this.#gen) this.#run.runStart = -1
  }

  /** Resolve when a frame at or after `ts` is output, the plan changes, or after `ms`. */
  #outputOf(ts: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined
        resolve()
      }, ms)
      this.#waiter = {
        ts,
        resolve: () => {
          clearTimeout(timer)
          this.#waiter = undefined
          resolve()
        },
      }
    })
  }

  /** Bytes of sample i, fetching a window of upcoming samples in one range request. */
  async #sampleBytes(i: number): Promise<Uint8Array> {
    const s = this.#samples!
    const off = s.offset[i]!
    const size = s.size[i]!
    const w = this.#bytes
    if (w && off >= w.start && off + size <= w.start + w.data.byteLength) {
      return w.data.subarray(off - w.start, off - w.start + size)
    }
    const last = Math.min(s.count - 1, i + FETCH_SAMPLES)
    let start = off
    let end = off + size
    for (let k = i; k <= last; k++) {
      const o = s.offset[k]!
      if (o < start) start = o
      if (o + s.size[k]! > end) end = o + s.size[k]!
    }
    const data = await this.#file.source.read(start, end - start)
    this.#stats.bytesFetched += data.byteLength
    this.#bytes = { start, data }
    return data.subarray(off - start, off - start + size)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const f of this.#frames) f.close()
    this.#frames.length = 0
    if (this.#decoder) {
      this.#stats.activeDecoders--
      if (this.#decoder.state !== 'closed') this.#decoder.close()
    }
    this.#bytes = undefined
  }

  /** @internal for stats overlays */
  get heldFrames(): number {
    return this.#frames.length
  }

  get track(): Mp4Track | undefined {
    return this.#track
  }
}
