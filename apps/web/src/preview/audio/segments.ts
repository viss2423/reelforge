/**
 * Lazily decoded audio segments with an LRU byte budget.
 *
 * MP4 proxies: the AAC samples of one {@link SEGMENT_US} window (plus a few frames of decoder
 * pre-roll) are fetched with coalesced Range requests — never the interleaved video bytes —
 * wrapped as ADTS and decoded with `decodeAudioData` (works on every browser, Safari
 * included, and decodes off the main thread). The result is trimmed to exactly
 * [seg·L, (seg+1)·L) so pieces from consecutive segments butt together sample-accurately.
 *
 * Anything else (MP3/WAV/OGG music uploaded without a proxy) is decoded whole once and
 * treated as a single segment.
 */
import { LruCache } from '../lru.ts'
import { coalesceRanges } from '../media/byteSource.ts'
import type { MediaFile, MediaFiles } from '../media/mediaFile.ts'
import type { Mp4Track } from '../media/mp4.ts'
import { parseAsc, toAdts } from './adts.ts'

/** Segment length (us): ~3.8 MB of stereo float at 48 kHz, decoded in ~10–30 ms. */
export const SEGMENT_US = 10_000_000
/** AAC frames decoded before the segment start to settle the decoder (MDCT overlap). */
const PREROLL_FRAMES = 3
/** Byte gap below which sample ranges are merged into one request. */
const COALESCE_GAP = 64 * 1024
/** Segment length used for whole-file decodes (finite so segment arithmetic stays exact). */
export const WHOLE_FILE_SEGMENT = 1e15
const WHOLE = WHOLE_FILE_SEGMENT

interface AssetAudio {
  /** Segment length (us), WHOLE for whole-file decodes; undefined while probing. */
  seg: number | undefined
  track: Mp4Track | undefined
  file: MediaFile
  failed: boolean
}

/** Index range [first, last] of samples whose presentation span intersects [t0, t1). */
export function sampleRange(
  cts: Float64Array,
  duration: Float64Array,
  count: number,
  t0: number,
  t1: number,
): [number, number] {
  // audio samples are in presentation order; binary search the first sample ending after t0
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cts[mid]! + duration[mid]! <= t0) lo = mid + 1
    else hi = mid
  }
  const first = lo
  let last = first - 1
  while (last + 1 < count && cts[last + 1]! < t1) last++
  return [first, last]
}

export class AudioSegments {
  readonly #ctx: BaseAudioContext
  readonly #files: MediaFiles
  readonly #assets = new Map<string, AssetAudio>()
  readonly #cache: LruCache<string, AudioBuffer>
  readonly #loading = new Set<string>()
  /** Called when a segment finishes decoding (so the engine can schedule it at once). */
  onReady: (() => void) | undefined

  constructor(ctx: BaseAudioContext, files: MediaFiles, maxBytes: number) {
    this.#ctx = ctx
    this.#files = files
    this.#cache = new LruCache(maxBytes)
  }

  /** Segment length for `url` (us); undefined while the file is being probed. */
  segmentLength(url: string): number | undefined {
    return this.#asset(url).seg
  }

  #asset(url: string): AssetAudio {
    let a = this.#assets.get(url)
    if (!a) {
      const entry: AssetAudio = {
        seg: undefined,
        track: undefined,
        file: this.#files.open(url),
        failed: false,
      }
      a = entry
      this.#assets.set(url, entry)
      entry.file.info().then(
        (info) => {
          const t = info.audio
          if (t && t.format === 'mp4a' && t.description) {
            entry.track = t
            entry.seg = SEGMENT_US
          } else if (t) {
            entry.seg = WHOLE // e.g. Opus/ALAC in MP4: let the browser decode the whole file
          } else {
            entry.failed = true
          }
          this.onReady?.()
        },
        () => {
          entry.seg = WHOLE // not MP4 at all
          this.onReady?.()
        },
      )
    }
    return a
  }

  /** Decoded segment (optionally time-reversed), or undefined (load started). */
  get(url: string, seg: number, reversed: boolean): AudioBuffer | undefined {
    const key = `${url}|${seg}|${reversed ? 'r' : 'f'}`
    const hit = this.#cache.get(key)
    if (hit) return hit
    if (reversed) {
      const fwd = this.get(url, seg, false)
      if (!fwd) return undefined
      const rev = reverseBuffer(this.#ctx, fwd)
      this.#cache.set(key, rev, bufferBytes(rev))
      return rev
    }
    const a = this.#asset(url)
    if (a.seg === undefined || a.failed || this.#loading.has(key)) return undefined
    this.#loading.add(key)
    const job = a.seg === WHOLE ? this.#decodeWhole(a) : this.#decodeSegment(a, seg)
    job
      .then((buf) => {
        this.#cache.set(key, buf, bufferBytes(buf))
        this.onReady?.()
      })
      .catch(() => {
        // a corrupt / unsupported stream: stay silent rather than retrying every frame
        a.failed = true
      })
      .finally(() => this.#loading.delete(key))
    return undefined
  }

  async #decodeWhole(a: AssetAudio): Promise<AudioBuffer> {
    const res = await fetch(a.file.url, { credentials: 'include' })
    if (!res.ok) throw new Error(`GET ${a.file.url} → HTTP ${res.status}`)
    return this.#ctx.decodeAudioData(await res.arrayBuffer())
  }

  async #decodeSegment(a: AssetAudio, seg: number): Promise<AudioBuffer> {
    const t = a.track!
    const s = t.samples
    const t0 = seg * SEGMENT_US
    const t1 = t0 + SEGMENT_US
    const [hitFirst, last] = sampleRange(s.cts, s.duration, s.count, t0, t1)
    const first = Math.max(0, hitFirst - PREROLL_FRAMES)
    if (last < first)
      return this.#ctx.createBuffer(Math.max(1, t.channels), 1, this.#ctx.sampleRate)
    const ranges = []
    for (let i = first; i <= last; i++)
      ranges.push({ start: s.offset[i]!, end: s.offset[i]! + s.size[i]! })
    const merged = coalesceRanges(ranges, COALESCE_GAP)
    const chunks = await Promise.all(
      merged.map((r) => a.file.source.read(r.start, r.end - r.start)),
    )
    const frames: Uint8Array[] = []
    let ri = 0
    for (let i = first; i <= last; i++) {
      const off = s.offset[i]!
      while (off >= merged[ri]!.end) ri++
      const base = merged[ri]!.start
      frames.push(chunks[ri]!.subarray(off - base, off - base + s.size[i]!))
    }
    const adts = toAdts(parseAsc(t.description!), frames)
    const decoded = await this.#ctx.decodeAudioData(adts.buffer as ArrayBuffer)
    // decoded sample 0 corresponds to the cts of the first fed frame
    return trimBuffer(this.#ctx, decoded, (t0 - s.cts[first]!) / 1e6, SEGMENT_US / 1e6)
  }

  /** Bytes held by decoded segments. */
  get bytes(): number {
    return this.#cache.size
  }

  /** Forget assets whose URL is no longer used. */
  retain(urls: ReadonlySet<string>): void {
    for (const url of this.#assets.keys()) if (!urls.has(url)) this.#assets.delete(url)
  }

  clear(): void {
    this.#cache.clear()
  }
}

const bufferBytes = (b: AudioBuffer): number => b.length * b.numberOfChannels * 4

/** Copy [start, start + length) seconds of `src` into a new buffer (zero-padded at the ends). */
export function trimBuffer(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  start: number,
  length: number,
): AudioBuffer {
  const sr = src.sampleRate
  const n = Math.max(1, Math.round(length * sr))
  const from = Math.round(start * sr)
  const out = ctx.createBuffer(src.numberOfChannels, n, sr)
  for (let c = 0; c < src.numberOfChannels; c++) {
    const data = src.getChannelData(c)
    const s0 = Math.max(0, from)
    const s1 = Math.min(data.length, from + n)
    if (s1 > s0) out.copyToChannel(data.subarray(s0, s1), c, s0 - from)
  }
  return out
}

/** Time-reversed copy of a buffer (reverse playback; WebAudio cannot play backwards). */
export function reverseBuffer(ctx: BaseAudioContext, src: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate)
  for (let c = 0; c < src.numberOfChannels; c++) {
    const a = src.getChannelData(c)
    const b = out.getChannelData(c)
    for (let i = 0, j = a.length - 1; j >= 0; i++, j--) b[i] = a[j]!
  }
  return out
}
