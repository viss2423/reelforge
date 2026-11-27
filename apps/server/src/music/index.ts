/**
 * Automatic music: royalty-free library search, suggestions ranked for a reel, chorus
 * detection, previews and import as a project asset.
 *
 * Public API (for the HTTP routes, the `music.suggest` job and the Auto Edit flow):
 *
 * - `suggestMusic(ctx, request)` → ranked tracks; the best few are downloaded and analysed
 *   (BPM, energy, chorus) so the first pick can be inserted immediately.
 * - `importMusic(ctx, trackId, { length })` → a new audio Asset (with `music` licence
 *   metadata, beats and the chorus section) + the analysis; probe runs next.
 * - `musicServiceFor(paths, tools)` → the shared MusicService (search, preview, sources).
 *
 * Insert the imported asset with core `insertMusicClip` (trim to the reel, chorus start,
 * fades, beat markers, duck under speech).
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type Asset,
  type JobKind,
  type LibraryTrack,
  type MusicImportResult,
  type MusicSearchQuery,
  type MusicSourceInfo,
  MusicSuggestRequest,
  type MusicSuggestResult,
  newId,
  type ServerEvent,
  type TrendSoundProfile,
} from '@reelforge/core'
import type { DataPaths, JobDefinition, Logger, Store, Toolchain } from '../contracts.ts'
import { assetDir, assetFile } from '../paths.ts'
import { MusicLibrary, type TrackAnalysis } from './library.ts'
import type { FetchLike } from './net.ts'
import { dedupeTracks, rankTracks } from './rank.ts'
import { CcmixterSource } from './sources/ccmixter.ts'
import { JamendoSource } from './sources/jamendo.ts'
import { OpenverseSource } from './sources/openverse.ts'
import { MOODS, type MusicSource, type SourceQuery, tokens } from './types.ts'

export { MusicLibrary } from './library.ts'
export type { MusicSource, SourceTrack } from './types.ts'

export interface MusicServiceOptions {
  dir: string
  ffmpeg: string
  /** Defaults to Openverse + ccMixter (+ Jamendo with a client id); [] when offline. */
  sources?: readonly MusicSource[]
  jamendoClientId?: string | undefined
  online?: boolean
  log?: Logger
  fetch?: FetchLike
  maxCacheBytes?: number
  now?: () => number
  /** Today's trending sounds (from the trend engine), best first; [] when unknown. */
  trendSounds?: () => readonly TrendSoundProfile[]
}

/** How many of today's top sounds trend order compares against. */
const TREND_SOUNDS = 5

/** What import needs from the host (a JobContext or the HTTP deps both fit). */
export interface ImportContext {
  paths: DataPaths
  store: Pick<Store, 'putAsset'>
  emit(event: ServerEvent): void
  enqueue(kind: JobKind, payload: unknown, opts?: { assetId?: string }): unknown
}

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
}

// Control characters plus the characters Windows forbids in file names.
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSAFE_NAME = /[\u0000-\u001f<>:"/\\|?*]+/g

const safeName = (s: string) =>
  s.replace(UNSAFE_NAME, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Music'

export class MusicService {
  readonly library: MusicLibrary
  readonly #log: Logger | undefined
  readonly #trendSounds: () => readonly TrendSoundProfile[]

  constructor(opts: MusicServiceOptions) {
    const f = opts.fetch ? { fetch: opts.fetch } : {}
    const sources =
      opts.sources ??
      (opts.online === false
        ? []
        : [
            new OpenverseSource(f),
            new CcmixterSource(f),
            new JamendoSource({ clientId: opts.jamendoClientId, ...f }),
          ])
    this.#log = opts.log
    this.#trendSounds = opts.trendSounds ?? (() => [])
    this.library = new MusicLibrary({
      dir: opts.dir,
      ffmpeg: opts.ffmpeg,
      sources,
      ...(opts.log ? { log: opts.log } : {}),
      ...f,
      ...(opts.maxCacheBytes !== undefined ? { maxCacheBytes: opts.maxCacheBytes } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    })
  }

  sources(): MusicSourceInfo[] {
    return this.library.sources.map((s) => {
      const why = s.unavailable()
      return {
        id: s.id,
        name: s.name,
        available: !why,
        ...(why ? { note: why } : {}),
        homepage: s.homepage,
      }
    })
  }

  /** Browse/search the library (metadata only; nothing is downloaded). */
  async search(
    q: MusicSearchQuery,
    signal?: AbortSignal,
  ): Promise<{ tracks: LibraryTrack[]; warnings: string[] }> {
    const profile = q.mood ? MOODS[q.mood] : undefined
    const terms = [q.q, profile?.terms, q.genre].filter(Boolean).join(' ').trim()
    const query: SourceQuery = {
      terms,
      tags: [...(q.genre ? [q.genre.toLowerCase()] : []), ...(profile?.tags.slice(0, 2) ?? [])],
      limit: 20,
    }
    const { tracks, warnings } = await this.library.search(query, {
      ...(q.source ? { only: q.source } : {}),
      ...(signal ? { signal } : {}),
    })
    const cached = q.source ? [] : await this.library.searchCached(tokens(terms))
    let wire = await this.library.toWire(dedupeTracks([...tracks, ...cached]))
    if (q.bpmMin !== undefined || q.bpmMax !== undefined)
      wire = wire.filter(
        (t) => t.bpm === undefined || ((q.bpmMin ?? 0) <= t.bpm && t.bpm <= (q.bpmMax ?? 999)),
      )
    if (q.mood || q.q || q.genre)
      wire = rankTracks(wire, {
        mood: q.mood,
        vibe: q.q,
        genre: q.genre,
        duration: 30_000_000,
        hasSpeech: false,
      })
    return { tracks: wire.slice(0, q.limit), warnings }
  }

  /** Ranked suggestions for a reel; the best `analyze` are downloaded and analysed. */
  async suggest(
    input: MusicSuggestRequest,
    opts: { signal?: AbortSignal; onProgress?: (p: number, msg: string) => void } = {},
  ): Promise<MusicSuggestResult> {
    const started = performance.now()
    const r = MusicSuggestRequest.parse(input)
    const trend = r.sound
      ? [r.sound]
      : r.order === 'trend'
        ? this.#trendSounds().slice(0, TREND_SOUNDS)
        : []
    // Matching one sound: search in its style when the caller gave no mood/genre.
    const mood = r.mood ?? (r.sound ? r.sound.mood : undefined)
    const genre = r.genre ?? (r.sound ? r.sound.genre : undefined)
    const profile = mood ? MOODS[mood] : undefined
    const terms = [r.vibe, profile?.terms, genre].filter(Boolean).join(' ').trim() || 'background'
    opts.onProgress?.(0.05, 'Searching the music library')
    const { tracks, warnings } = await this.library.search(
      {
        terms,
        tags: [...(genre ? [genre.toLowerCase()] : []), ...(profile?.tags.slice(0, 2) ?? [])],
        instrumental: r.hasSpeech,
        limit: 20,
      },
      opts.signal ? { signal: opts.signal } : {},
    )
    const cached = await this.library.searchCached(tokens(terms))
    const rq = {
      mood,
      vibe: r.vibe,
      genre,
      targetBpm: r.targetBpm ?? (r.sound?.bpm || undefined),
      duration: r.duration,
      hasSpeech: r.hasSpeech,
      trend,
    }
    let ranked = rankTracks(await this.library.toWire(dedupeTracks([...tracks, ...cached])), rq)
    if (ranked.length === 0) {
      warnings.push(
        this.library.sources.length === 0
          ? 'Online music search is off and nothing is cached yet'
          : 'No royalty-free tracks matched — try another vibe',
      )
      return { tracks: [], terms, warnings, tookMs: Math.round(performance.now() - started) }
    }

    // Analyse the best few (downloads run in parallel; analysis is one decode each).
    const head = ranked.slice(0, r.analyze)
    let done = 0
    await Promise.all(
      head.map(async (t) => {
        try {
          await this.library.analyze(t.id, opts.signal)
        } catch (err) {
          if (opts.signal?.aborted) throw err
          warnings.push(`${t.title}: ${err instanceof Error ? err.message : String(err)}`)
          this.#log?.warn({ err, track: t.id }, 'music analysis failed')
        } finally {
          done++
          opts.onProgress?.(
            0.2 + (0.75 * done) / Math.max(1, head.length),
            `Analysing ${done}/${head.length}`,
          )
        }
      }),
    )
    const top = ranked.slice(0, Math.max(r.limit, r.analyze) + 4)
    const refreshed = await this.library.toWire(
      (await Promise.all(top.map((t) => this.library.get(t.id)))).filter((t) => t !== undefined),
    )
    ranked = rankTracks(refreshed, rq)
    const out = await Promise.all(
      ranked.slice(0, r.limit).map(async (t) => {
        const section = await this.#section(t.id, r.duration)
        return section ? { ...t, section } : t
      }),
    )
    // Analysed (instantly insertable) picks first among near-equal scores.
    out.sort((a, b) => b.score + (b.analyzed ? 0.03 : 0) - (a.score + (a.analyzed ? 0.03 : 0)))
    return { tracks: out, terms, warnings, tookMs: Math.round(performance.now() - started) }
  }

  async #section(id: string, length: number) {
    const a = await this.#analysisIfAny(id)
    if (!a) return undefined
    const s = MusicLibrary.section(a, length)
    return { start: s.start, end: s.end }
  }

  async #analysisIfAny(id: string): Promise<TrackAnalysis | undefined> {
    const d = await this.library.describe(id)
    return d?.analyzed ? this.library.analyze(id) : undefined
  }

  /** Downloads, analyses and registers the track as a new audio asset (probe follows). */
  async import(
    ctx: ImportContext,
    trackId: string,
    opts: { length?: number; signal?: AbortSignal } = {},
  ): Promise<MusicImportResult> {
    const track = await this.library.get(trackId)
    if (!track) throw new Error(`unknown track ${trackId} — search again`)
    const analysis = await this.library.analyze(trackId, opts.signal)
    const file = await this.library.ensureAudio(trackId, opts.signal)
    const ext = path.extname(file).toLowerCase() || '.mp3'
    const section = MusicLibrary.section(analysis, opts.length ?? 30_000_000)
    const name = `${safeName(track.artist ? `${track.artist} - ${track.title}` : track.title)}${ext}`
    const asset: Asset = {
      id: newId('a'),
      kind: 'audio',
      name,
      size: (await stat(file)).size,
      mime: MIME[ext] ?? 'audio/mpeg',
      createdAt: new Date().toISOString(),
      // Decoded length (100 ms resolution) never overshoots the file; probe refines it.
      duration: analysis.envelope.length > 0 ? analysis.envelope.length * 100_000 : track.duration,
      hasAudio: true,
      hasVideo: false,
      proxy: 'pending',
      thumbnails: 'pending',
      waveform: 'pending',
      beats: analysis.beats,
      music: {
        source: track.source,
        trackId: track.id,
        title: track.title.slice(0, 300),
        artist: track.artist.slice(0, 300),
        licence: track.licence,
        ...(track.attribution ? { attribution: track.attribution.slice(0, 1000) } : {}),
        ...(track.pageUrl ? { pageUrl: track.pageUrl.slice(0, 500) } : {}),
        ...(analysis.bpm > 0 ? { bpm: Math.round(analysis.bpm * 10) / 10 } : {}),
        energy: analysis.energy,
        section: { start: section.start, end: section.end },
        downbeats: analysis.downbeats,
      },
    }
    await mkdir(assetDir(ctx.paths, asset.id), { recursive: true })
    await copyFile(file, assetFile(ctx.paths, asset, 'original'))
    ctx.store.putAsset(asset)
    ctx.emit({ type: 'asset', asset })
    ctx.enqueue('probe', { assetId: asset.id }, { assetId: asset.id })
    return {
      asset,
      bpm: analysis.bpm,
      beats: analysis.beats,
      downbeats: analysis.downbeats,
      section: { start: section.start, end: section.end },
    }
  }
}

/* ------------------------------------------------------------------ shared instance */

let defaults: Partial<MusicServiceOptions> = {}
const services = new Map<string, MusicService>()

/** Boot-time options (online search, Jamendo key, logger). Call before the queue starts. */
export const configureMusic = (opts: Partial<MusicServiceOptions>): void => {
  defaults = opts
  services.clear()
}

/** Installs a specific service for a data directory (tests, custom sources). */
export const setMusicService = (root: string, service: MusicService | undefined): void => {
  if (service) services.set(root, service)
  else services.delete(root)
}

/** The music service for a data directory (one per process and data dir). */
export const musicServiceFor = (
  paths: DataPaths,
  tools: Pick<Toolchain, 'ffmpeg'>,
): MusicService => {
  let s = services.get(paths.root)
  if (!s) {
    s = new MusicService({ ...defaults, dir: path.join(paths.root, 'music'), ffmpeg: tools.ffmpeg })
    services.set(paths.root, s)
  }
  return s
}

/** Ranked music for a reel (see MusicService.suggest). Usable from any job. */
export const suggestMusic = (
  ctx: { paths: DataPaths; tools: Pick<Toolchain, 'ffmpeg'>; signal?: AbortSignal },
  request: MusicSuggestRequest,
  onProgress?: (p: number, msg: string) => void,
): Promise<MusicSuggestResult> =>
  musicServiceFor(ctx.paths, ctx.tools).suggest(request, {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  })

/** Imports a suggested track as a project asset (see MusicService.import). */
export const importMusic = (
  ctx: ImportContext & { tools: Pick<Toolchain, 'ffmpeg'>; signal?: AbortSignal },
  trackId: string,
  opts: { length?: number } = {},
): Promise<MusicImportResult> =>
  musicServiceFor(ctx.paths, ctx.tools).import(ctx, trackId, {
    ...opts,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  })

/** `music.suggest`: network + one decode per analysed track → the cpu class. */
export const musicSuggestJob: JobDefinition = {
  kind: 'music.suggest',
  resource: 'cpu',
  defaultPriority: 25,
  handler: async (ctx) => {
    const result = await suggestMusic(
      { paths: ctx.paths, tools: ctx.tools, signal: ctx.signal },
      MusicSuggestRequest.parse(ctx.payload ?? {}),
      (p, msg) => ctx.progress(p, msg),
    )
    const best = result.tracks[0]
    ctx.progress(1, best ? `${best.title} — ${best.artist}` : 'No music found')
    return result
  },
}

export const musicJobs: JobDefinition[] = [musicSuggestJob]
