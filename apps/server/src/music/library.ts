/**
 * The host's music library: searches the sources (cached on disk for a day, stale cache
 * used when a source is offline or rate limited), downloads picked tracks once into
 * `<data>/music/tracks/<key>/`, analyses them (BPM, beats, bars, loudness envelope → energy
 * and chorus) with the beat tracker's single decode pass, renders 10 s previews, and prunes
 * the least recently used audio beyond a size budget.
 *
 * Layout:
 *   music/search/<sha1(source+query)>.json   { at, tracks: SourceTrack[] }
 *   music/tracks/<source>-<hash>/meta.json   SourceTrack + { ext, lastUsedAt }
 *   music/tracks/<source>-<hash>/audio.<ext> the original download
 *   music/tracks/<source>-<hash>/analysis.json
 *   music/tracks/<source>-<hash>/preview.m4a
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { LibraryTrack } from '@reelforge/core'
import type { Logger } from '../contracts.ts'
import { analyzeBeats } from '../ai/beats/index.ts'
import { BEAT_SAMPLE_RATE } from '../ai/beats/tracker.ts'
import { FF_BASE } from '../ai/media.ts'
import { runChecked } from '../ai/proc.ts'
import { assertPublicHttps, type FetchLike, USER_AGENT } from './net.ts'
import { EnergyEnvelope, findBestSection, type Section, trackEnergy } from './sections.ts'
import type { MusicSource, SourceQuery, SourceTrack } from './types.ts'

export const PREVIEW_LENGTH = 10_000_000
const DAY = 24 * 3600 * 1000
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024

export interface TrackAnalysis {
  bpm: number
  beats: number[]
  downbeats: number[]
  energy: number
  /** dBFS per 100 ms frame (rounded to 0.1 dB). */
  envelope: number[]
  /** Analysis wall time (ms), for measurements. */
  ms: number
}

interface StoredMeta extends SourceTrack {
  ext: string
  lastUsedAt: string
}

export interface MusicLibraryOptions {
  /** `<data>/music` */
  dir: string
  ffmpeg: string
  sources: readonly MusicSource[]
  log?: Logger
  fetch?: FetchLike
  /** Search cache lifetime (default 24 h). */
  searchTtlMs?: number
  /** Audio cache budget (default 1 GiB). */
  maxCacheBytes?: number
  now?: () => number
}

export interface SearchOutcome {
  tracks: SourceTrack[]
  warnings: string[]
}

const EXT_BY_TYPE: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/mp4': '.m4a',
  'audio/aac': '.m4a',
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

/** Directory name for a track id (`openverse:3b45…` → `openverse-<sha1/16>`). */
export const trackKey = (id: string): string => {
  const source =
    id
      .split(':', 1)[0]!
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 20) || 'x'
  return `${source}-${sha1(id).slice(0, 16)}`
}

const toWire = (t: SourceTrack | StoredMeta, cached: boolean, a?: TrackAnalysis): LibraryTrack => {
  const { audioUrl: _url, ...rest } = t
  const out: LibraryTrack = { ...rest, cached, analyzed: Boolean(a) }
  delete (out as Partial<StoredMeta>).ext
  delete (out as Partial<StoredMeta>).lastUsedAt
  if (a) {
    if (a.bpm > 0) out.bpm = Math.round(a.bpm * 10) / 10
    out.energy = a.energy
  }
  return out
}

export class MusicLibrary {
  readonly dir: string
  readonly sources: readonly MusicSource[]
  readonly #opts: MusicLibraryOptions
  readonly #fetch: FetchLike
  readonly #now: () => number
  /** Every track seen in a search or on disk, by id. */
  readonly #known = new Map<string, SourceTrack>()
  readonly #analysis = new Map<string, TrackAnalysis>()
  readonly #inflight = new Map<string, Promise<unknown>>()
  #loaded: Promise<void> | undefined
  /** Network requests made (searches + downloads), for cache measurements/tests. */
  readonly stats = { searches: 0, searchCacheHits: 0, downloads: 0, analyses: 0 }

  constructor(opts: MusicLibraryOptions) {
    this.#opts = opts
    this.dir = opts.dir
    this.sources = opts.sources
    this.#fetch = opts.fetch ?? fetch
    this.#now = opts.now ?? Date.now
  }

  #trackDir(id: string): string {
    return path.join(this.dir, 'tracks', trackKey(id))
  }

  /** Loads cached track metadata once (cheap: one small JSON per cached track). */
  async #load(): Promise<void> {
    this.#loaded ??= (async () => {
      const root = path.join(this.dir, 'tracks')
      let names: string[] = []
      try {
        names = await readdir(root)
      } catch {
        return
      }
      await Promise.all(
        names.map(async (name) => {
          try {
            const meta = JSON.parse(
              await readFile(path.join(root, name, 'meta.json'), 'utf8'),
            ) as StoredMeta
            if (meta.id && trackKey(meta.id) === name && !this.#known.has(meta.id))
              this.#known.set(meta.id, meta)
          } catch {
            // Half-written or foreign directory: ignored (and pruned eventually).
          }
        }),
      )
    })()
    return this.#loaded
  }

  async #meta(id: string): Promise<StoredMeta | undefined> {
    try {
      return JSON.parse(
        await readFile(path.join(this.#trackDir(id), 'meta.json'), 'utf8'),
      ) as StoredMeta
    } catch {
      return undefined
    }
  }

  isCached(id: string): boolean {
    const t = this.#known.get(id) as Partial<StoredMeta> | undefined
    return Boolean(t?.ext) && existsSync(path.join(this.#trackDir(id), `audio${t!.ext}`))
  }

  /** Wire view of a known track (with analysis when available). */
  async describe(id: string): Promise<LibraryTrack | undefined> {
    await this.#load()
    const t = this.#known.get(id)
    if (!t) return undefined
    return toWire(t, this.isCached(id), await this.#readAnalysis(id))
  }

  async get(id: string): Promise<SourceTrack | undefined> {
    await this.#load()
    return this.#known.get(id)
  }

  /* ------------------------------------------------------------------ search */

  /**
   * Searches every usable source in parallel (or just `only`). Fresh cached results are
   * used without a request; on failure the stale cache is used and a warning returned.
   */
  async search(
    q: SourceQuery,
    opts: { only?: string; signal?: AbortSignal } = {},
  ): Promise<SearchOutcome> {
    await this.#load()
    const warnings: string[] = []
    const lists = await Promise.all(
      this.sources
        .filter((s) => !opts.only || s.id === opts.only)
        .map(async (s) => {
          const file = path.join(
            this.dir,
            'search',
            `${sha1(`${s.id}\n${JSON.stringify(q)}`)}.json`,
          )
          const cached = await readFile(file, 'utf8')
            .then((txt) => JSON.parse(txt) as { at: number; tracks: SourceTrack[] })
            .catch(() => undefined)
          const ttl = this.#opts.searchTtlMs ?? DAY
          if (cached && this.#now() - cached.at < ttl) {
            this.stats.searchCacheHits++
            return cached.tracks
          }
          const why = s.unavailable()
          if (why) {
            if (!s.id.startsWith('jamendo') || !why.includes('client id'))
              warnings.push(`${s.name}: ${why}`)
            return cached?.tracks ?? []
          }
          try {
            this.stats.searches++
            const tracks = await s.search(q, opts.signal)
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(file, JSON.stringify({ at: this.#now(), tracks }))
            return tracks
          } catch (err) {
            if (opts.signal?.aborted) throw err
            warnings.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`)
            return cached?.tracks ?? []
          }
        }),
    )
    // Interleave sources so each contributes its best results first.
    const tracks: SourceTrack[] = []
    for (let i = 0; lists.some((l) => i < l.length); i++)
      for (const l of lists) if (i < l.length) tracks.push(l[i]!)
    for (const t of tracks) if (!this.#known.has(t.id)) this.#known.set(t.id, t)
    return { tracks, warnings }
  }

  /** Cached (downloaded) tracks matching any of `words` — works fully offline. */
  async searchCached(words: readonly string[]): Promise<SourceTrack[]> {
    await this.#load()
    const out: SourceTrack[] = []
    for (const t of this.#known.values()) {
      if (!this.isCached(t.id)) continue
      const hay = `${t.title} ${t.artist} ${t.tags.join(' ')} ${t.genres.join(' ')}`.toLowerCase()
      if (words.length === 0 || words.some((w) => hay.includes(w))) out.push(t)
    }
    return out
  }

  /** Wire views for search results (adds cache + analysis state). */
  async toWire(tracks: readonly SourceTrack[]): Promise<LibraryTrack[]> {
    return Promise.all(
      tracks.map(async (t) => toWire(t, this.isCached(t.id), await this.#readAnalysis(t.id))),
    )
  }

  /* ------------------------------------------------------------------ download */

  /** Single-flight per key. */
  #once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.#inflight.get(key) as Promise<T> | undefined
    if (running) return running
    const p = fn().finally(() => this.#inflight.delete(key))
    this.#inflight.set(key, p)
    return p
  }

  /** Downloads the track once; returns the local audio file. */
  async ensureAudio(id: string, signal?: AbortSignal): Promise<string> {
    await this.#load()
    const track = this.#known.get(id)
    if (!track) throw new Error(`unknown track ${id} — search again`)
    const dir = this.#trackDir(id)
    const known = track as Partial<StoredMeta>
    if (known.ext && existsSync(path.join(dir, `audio${known.ext}`))) {
      await this.#touch(id)
      return path.join(dir, `audio${known.ext}`)
    }
    return this.#once(`dl:${id}`, async () => {
      const url = assertPublicHttps(track.audioUrl)
      await mkdir(dir, { recursive: true })
      this.stats.downloads++
      const timeout = AbortSignal.timeout(120_000)
      const res = await this.#fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'audio/*' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'follow',
      })
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`)
      if (res.url) assertPublicHttps(res.url)
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (type && !type.startsWith('audio/') && type !== 'application/octet-stream')
        throw new Error(`not an audio file (${type})`)
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (declared > MAX_DOWNLOAD_BYTES) throw new Error('track is too large')
      const ext = EXT_BY_TYPE[type] ?? '.mp3'
      const tmp = path.join(dir, `audio.download`)
      let bytes = 0
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length
          cb(bytes > MAX_DOWNLOAD_BYTES ? new Error('track is too large') : null, chunk)
        },
      })
      try {
        await pipeline(
          Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
          limit,
          createWriteStream(tmp),
        )
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
      const file = path.join(dir, `audio${ext}`)
      await rename(tmp, file)
      const meta: StoredMeta = { ...track, ext, lastUsedAt: new Date(this.#now()).toISOString() }
      await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta))
      this.#known.set(id, meta)
      void this.prune().catch((err: unknown) =>
        this.#opts.log?.warn({ err }, 'music cache prune failed'),
      )
      return file
    })
  }

  async #touch(id: string): Promise<void> {
    const meta = await this.#meta(id)
    if (!meta) return
    meta.lastUsedAt = new Date(this.#now()).toISOString()
    await writeFile(path.join(this.#trackDir(id), 'meta.json'), JSON.stringify(meta)).catch(
      () => undefined,
    )
  }

  /* ------------------------------------------------------------------ analysis */

  async #readAnalysis(id: string): Promise<TrackAnalysis | undefined> {
    const mem = this.#analysis.get(id)
    if (mem) return mem
    try {
      const a = JSON.parse(
        await readFile(path.join(this.#trackDir(id), 'analysis.json'), 'utf8'),
      ) as TrackAnalysis
      this.#analysis.set(id, a)
      return a
    } catch {
      return undefined
    }
  }

  /** Downloads (if needed) and analyses the track once; cached on disk. */
  async analyze(id: string, signal?: AbortSignal): Promise<TrackAnalysis> {
    const cached = await this.#readAnalysis(id)
    if (cached) return cached
    const file = await this.ensureAudio(id, signal)
    return this.#once(`an:${id}`, async () => {
      const started = performance.now()
      this.stats.analyses++
      const env = new EnergyEnvelope(BEAT_SAMPLE_RATE)
      const beats = await analyzeBeats({
        ffmpeg: this.#opts.ffmpeg,
        file,
        tap: (s) => env.push(s),
        ...(signal ? { signal } : {}),
      })
      const envelope = env.finish()
      const a: TrackAnalysis = {
        bpm: beats.bpm,
        beats: beats.beats,
        downbeats: beats.downbeats,
        energy: trackEnergy(envelope, beats.bpm),
        envelope: Array.from(envelope, (v) => Math.round(v * 10) / 10),
        ms: Math.round(performance.now() - started),
      }
      await writeFile(path.join(this.#trackDir(id), 'analysis.json'), JSON.stringify(a))
      this.#analysis.set(id, a)
      return a
    })
  }

  /** Best `length` µs section (chorus), starting on a bar when bars are known. */
  static section(a: TrackAnalysis, length: number): Section {
    const candidates = a.downbeats.length >= 4 ? a.downbeats : a.beats
    return findBestSection(Float32Array.from(a.envelope), { length, candidates })
  }

  /* ------------------------------------------------------------------ preview */

  /** 10 s AAC preview from the chorus (rendered once, then served from disk). */
  async preview(id: string, signal?: AbortSignal): Promise<string> {
    const out = path.join(this.#trackDir(id), 'preview.m4a')
    if (existsSync(out)) return out
    const a = await this.analyze(id, signal)
    const file = await this.ensureAudio(id, signal)
    return this.#once(`pv:${id}`, async () => {
      const { start } = MusicLibrary.section(a, PREVIEW_LENGTH)
      const tmp = `${out}.tmp.m4a`
      const len = PREVIEW_LENGTH / 1e6
      await runChecked(
        'ffmpeg',
        this.#opts.ffmpeg,
        [
          ...FF_BASE,
          '-ss',
          String(start / 1e6),
          '-t',
          String(len),
          '-i',
          file,
          '-vn',
          '-map',
          '0:a:0',
          '-af',
          `afade=t=in:d=0.15,afade=t=out:st=${len - 0.6}:d=0.6`,
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          '-y',
          tmp,
        ],
        signal ? { signal } : {},
      )
      await rename(tmp, out)
      return out
    })
  }

  /* ------------------------------------------------------------------ cache budget */

  /** Deletes least-recently-used cached tracks until the cache fits its budget. */
  async prune(): Promise<{ removed: number; bytes: number }> {
    const budget = this.#opts.maxCacheBytes ?? 1024 ** 3
    const root = path.join(this.dir, 'tracks')
    let names: string[] = []
    try {
      names = await readdir(root)
    } catch {
      return { removed: 0, bytes: 0 }
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        const dir = path.join(root, name)
        const files = await readdir(dir).catch(() => [] as string[])
        const sizes = await Promise.all(
          files.map((f) =>
            stat(path.join(dir, f)).then(
              (s) => s.size,
              () => 0,
            ),
          ),
        )
        const bytes = sizes.reduce((a, b) => a + b, 0)
        const meta = await readFile(path.join(dir, 'meta.json'), 'utf8')
          .then((s) => JSON.parse(s) as StoredMeta)
          .catch(() => undefined)
        return { dir, bytes, id: meta?.id, used: meta ? Date.parse(meta.lastUsedAt) || 0 : 0 }
      }),
    )
    let total = entries.reduce((s, e) => s + e.bytes, 0)
    let removed = 0
    const victims: typeof entries = []
    for (const e of entries.toSorted((a, b) => a.used - b.used)) {
      if (total <= budget) break
      if (
        e.id &&
        this.#inflight.size > 0 &&
        [...this.#inflight.keys()].some((k) => k.endsWith(e.id!))
      )
        continue
      victims.push(e)
      total -= e.bytes
      removed++
      if (e.id) {
        this.#analysis.delete(e.id)
        const t = this.#known.get(e.id) as Partial<StoredMeta> | undefined
        if (t?.ext) {
          const { ext: _e, lastUsedAt: _l, ...plain } = t as StoredMeta
          this.#known.set(e.id, plain)
        }
      }
    }
    await Promise.all(
      victims.map((e) =>
        rm(e.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
      ),
    )
    return { removed, bytes: total }
  }
}
