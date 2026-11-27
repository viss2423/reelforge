/**
 * The trend engine: fetch signals → rank existing items → generate new ones → publish the
 * `trending-live` pack and the Trending Now data. Runs as a low-priority `trends` job (AI
 * resource class, so it never overlaps another model) once a day at a quiet hour, at startup
 * when the last refresh is older than 24 h, and on demand from Settings / Trending Now.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MusicMood, PackManifest, TemplatePreset, TrendSoundProfile } from '@reelforge/core'
import type { JobDefinition, Logger } from '../contracts.ts'
import type { JobQueue } from '../jobs/queue.ts'
import { activeLocalDir, localPacksRoot, readLocalPack } from '../packs/local.ts'
import type { PacksService } from '../packs/service.ts'
import { LIVE_PACK, buildCatalogue } from './catalogue.ts'
import { extractSignals, normalize, topOf } from './extract.ts'
import {
  llmGenerate,
  reelIdeas,
  remixTemplates,
  soundsOf,
  type Origin,
  type ReelIdea,
} from './generate.ts'
import { PoliteHttp } from './http.ts'
import type { LlmPort } from './llm-port.ts'
import { buildLivePack, type LiveCollection } from './livepack.ts'
import { publishLivePack, type Exec, type PublishResult } from './publish.ts'
import { rankItems } from './rank.ts'
import { ALL_SOURCES } from './sources/index.ts'
import { SoundPreviews, soundFeel, soundProfile } from './sounds.ts'
import type { SourceItem, SourceStatus, TrendSignal, TrendSource } from './types.ts'

export interface TrendsConfig {
  enabled: boolean
  region: string
  /** Local hour (0-23) for the daily run. */
  hour: number
  youtubeKey?: string | undefined
  redditId?: string | undefined
  redditSecret?: string | undefined
  /** PUBLISH_TRENDS=github → auto-publish defaults to on (the UI toggle overrides). */
  publish: 'github' | undefined
  publishMode: 'pr' | 'main'
  publishRepo?: string | undefined
  /**
   * TRENDS_SOUND_PREVIEW=1: stream Deezer's 30 s preview clips in sync with the edit. Off by
   * default — Deezer's API terms (approved developers only, no combining content with
   * audiovisual images) do not cover it; see music/README.md "Trending sounds".
   */
  soundPreview?: boolean
}

export interface GeneratedItemInfo {
  ref: string
  collection: LiveCollection
  name: string
  trend: string
  kind: Origin['kind']
  createdAt: string
}

export interface TrendsState {
  generatedAt?: string
  lastAttemptAt?: string
  lastError?: string
  sources: SourceStatus[]
  signals: TrendSignal[]
  scores: Array<[string, number]>
  items: GeneratedItemInfo[]
  hashtags: string[]
  ideas: ReelIdea[]
  llm: { used: boolean; tokensPerSecond?: number; errors?: string[] }
  dropped: Array<{ ref: string; reason: string }>
  ms?: Record<string, number>
  publish?: { at: string; status: string; url?: string; error?: string }
  /** First time each sound (normalised title) was seen on a chart, ISO. */
  soundsSeen?: Record<string, string>
}

export interface TrendsSettings {
  autoPublish: boolean
}

export interface TrendsServiceOptions {
  dataRoot: string
  packs: PacksService
  config: TrendsConfig
  llm: LlmPort
  log: Logger
  ffmpeg: string
  userAgent: string
  settings: { get(): TrendsSettings | undefined; set(v: TrendsSettings): void }
  sources?: readonly TrendSource[]
  fetch?: typeof fetch
  http?: PoliteHttp
  exec?: Exec
  clock?: () => Date
  /** Unit tests: no FFmpeg thumbnails. */
  skipThumbs?: boolean
}

const STALE_MS = 24 * 3_600_000
const IDEA_TOPICS = 8
const MAX_IDEAS = 60

const emptyState = (): TrendsState => ({
  sources: [],
  signals: [],
  scores: [],
  items: [],
  hashtags: [],
  ideas: [],
  llm: { used: false },
  dropped: [],
})

export class TrendsService {
  readonly #o: TrendsServiceOptions
  readonly #dir: string
  readonly #http: PoliteHttp
  #state: TrendsState = emptyState()
  #running: Promise<TrendsState> | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #queue: JobQueue | undefined
  /** Official 30 s previews of trending sounds (streamed for playback only). */
  readonly previews: SoundPreviews

  constructor(opts: TrendsServiceOptions) {
    this.#o = opts
    this.previews = new SoundPreviews({
      userAgent: opts.userAgent,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    })
    this.#dir = path.join(opts.dataRoot, 'trends')
    this.#http =
      opts.http ??
      new PoliteHttp({
        cacheDir: path.join(this.#dir, 'cache'),
        userAgent: opts.userAgent,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      })
  }

  get state(): TrendsState {
    return this.#state
  }

  get running(): boolean {
    return this.#running !== undefined
  }

  #now(): Date {
    return this.#o.clock?.() ?? new Date()
  }

  settings(): TrendsSettings {
    return this.#o.settings.get() ?? { autoPublish: this.#o.config.publish === 'github' }
  }

  setSettings(next: TrendsSettings): TrendsSettings {
    this.#o.settings.set(next)
    return next
  }

  /** Loads persisted state and the last live pack into the packs overlay. */
  async init(): Promise<void> {
    try {
      this.#state = {
        ...emptyState(),
        ...(JSON.parse(await readFile(path.join(this.#dir, 'state.json'), 'utf8')) as TrendsState),
      }
    } catch {
      this.#state = emptyState()
    }
    const dir = await activeLocalDir(localPacksRoot(this.#o.dataRoot))
    const manifest = dir ? await readLocalPack(dir, LIVE_PACK, this.#o.log) : undefined
    this.#o.packs.setOverlay(
      {
        manifest,
        dir: manifest && dir ? path.join(dir, LIVE_PACK) : undefined,
        scores: new Map(this.#state.scores),
      },
      false,
    )
  }

  async #save(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    const file = path.join(this.#dir, 'state.json')
    await writeFile(`${file}.tmp`, JSON.stringify(this.#state))
    await rename(`${file}.tmp`, file)
  }

  /** Whether the last successful refresh is older than 24 h (or never happened). */
  stale(now = this.#now()): boolean {
    const at = this.#state.generatedAt ? Date.parse(this.#state.generatedAt) : Number.NaN
    return !Number.isFinite(at) || now.getTime() - at > STALE_MS
  }

  /* ------------------------------------------------------------------ scheduling */

  #activeJobId: string | undefined

  /** Enqueues a refresh job unless one is active. Returns its id. */
  enqueue(): string | undefined {
    const q = this.#queue
    if (!q) return undefined
    if (this.#activeJobId && q.active(this.#activeJobId)) return this.#activeJobId
    this.#activeJobId = q.enqueue('trends', {}).id
    return this.#activeJobId
  }

  /** Whether exports or other AI jobs are busy (the daily run waits for a quiet moment). */
  #busy(): boolean {
    const s = this.#queue?.stats()
    if (!s) return true
    return s['gpu-encode'].running + s['gpu-encode'].queued + s.ai.running + s.ai.queued > 0
  }

  /**
   * Decides whether to start a run now: when stale (startup / missed day) or at the quiet
   * hour on a day without a run, and only while no export or AI job is running.
   */
  shouldRun(now = this.#now()): boolean {
    if (!this.#o.config.enabled || this.#running || this.#busy()) return false
    if (this.stale(now)) {
      // Back off for an hour after a failed attempt so a dead network is not hammered.
      const last = this.#state.lastAttemptAt ? Date.parse(this.#state.lastAttemptAt) : 0
      return now.getTime() - last > 3_600_000
    }
    const last = this.#state.generatedAt ? new Date(this.#state.generatedAt) : undefined
    const ranToday = last !== undefined && last.toDateString() === now.toDateString()
    return now.getHours() === this.#o.config.hour && !ranToday
  }

  /** Next planned run time (ISO), for the UI. */
  nextRunAt(now = this.#now()): string {
    if (this.stale(now)) return now.toISOString()
    const next = new Date(now)
    next.setHours(this.#o.config.hour, 0, 0, 0)
    if (
      next <= now ||
      (this.#state.generatedAt &&
        new Date(this.#state.generatedAt).toDateString() === next.toDateString())
    )
      next.setDate(next.getDate() + 1)
    return next.toISOString()
  }

  /**
   * Connects the job queue and starts the scheduler: first check `delayMs` after boot (so a
   * stale engine refreshes soon after startup without slowing it), then every `checkMs`.
   */
  start(
    queue: JobQueue,
    opts: { schedule?: boolean; checkMs?: number; delayMs?: number } = {},
  ): void {
    const { schedule = true, checkMs = 10 * 60_000, delayMs = 90_000 } = opts
    this.#queue = queue
    this.stop()
    if (!this.#o.config.enabled || !schedule) return
    const tick = (): void => {
      if (this.shouldRun()) this.enqueue()
    }
    const first = setTimeout(() => {
      tick()
      this.#timer = setInterval(tick, checkMs)
      this.#timer.unref()
    }, delayMs)
    first.unref()
    this.#timer = first as unknown as ReturnType<typeof setInterval>
  }

  stop(): void {
    clearTimeout(this.#timer)
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  async idle(): Promise<void> {
    await this.#running?.catch(() => undefined)
  }

  /* ------------------------------------------------------------------ refresh */

  /** Runs a full refresh (single-flight). */
  refresh(
    signal: AbortSignal = new AbortController().signal,
    progress: (p: number, msg?: string) => void = () => {},
  ): Promise<TrendsState> {
    this.#running ??= this.#refresh(signal, progress).finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  async #fetchSources(
    signal: AbortSignal,
  ): Promise<Array<{ source: string; items: SourceItem[] }>> {
    const keys = {
      youtube: this.#o.config.youtubeKey,
      redditId: this.#o.config.redditId,
      redditSecret: this.#o.config.redditSecret,
    }
    const now = this.#now()
    const statuses: SourceStatus[] = []
    const results = await Promise.all(
      (this.#o.sources ?? ALL_SOURCES).map(async (src) => {
        const disabled = src.disabledReason({ keys })
        if (disabled) {
          statuses.push({
            id: src.id,
            name: src.name,
            state: 'disabled',
            items: 0,
            error: disabled,
          })
          return { source: src.id, items: [] as SourceItem[] }
        }
        const t0 = performance.now()
        try {
          const items = await src.fetch({
            get: (url, opts) => this.#http.get(url, { signal, ...opts }),
            fetch: this.#o.fetch ?? fetch,
            signal,
            now,
            region: this.#o.config.region,
            keys,
          })
          statuses.push({
            id: src.id,
            name: src.name,
            state: 'ok',
            items: items.length,
            ms: Math.round(performance.now() - t0),
            checkedAt: now.toISOString(),
          })
          return { source: src.id, items }
        } catch (err) {
          if (signal.aborted) throw err
          this.#o.log.warn({ source: src.id, err }, 'trend source failed')
          statuses.push({
            id: src.id,
            name: src.name,
            state: 'error',
            items: 0,
            ms: Math.round(performance.now() - t0),
            error: (err as Error).message,
            checkedAt: now.toISOString(),
          })
          return { source: src.id, items: [] as SourceItem[] }
        }
      }),
    )
    const order = (this.#o.sources ?? ALL_SOURCES).map((s) => s.id)
    this.#state.sources = statuses.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    return results
  }

  async #refresh(
    signal: AbortSignal,
    progress: (p: number, msg?: string) => void,
  ): Promise<TrendsState> {
    const t0 = performance.now()
    const now = this.#now()
    const ms: Record<string, number> = {}
    const lap = (key: string, since: number): number => {
      ms[key] = Math.round(performance.now() - since)
      return performance.now()
    }
    // A new state object per run: callers may still hold the previous run's result.
    this.#state = { ...this.#state, lastAttemptAt: now.toISOString() }
    try {
      progress(0.02, 'Reading trend sources')
      let t = performance.now()
      const raw = await this.#fetchSources(signal)
      if (
        raw.every((r) => r.items.length === 0) &&
        this.#state.sources.some((s) => s.state === 'error')
      )
        throw new Error('no trend source could be reached')
      const signals = extractSignals(raw, now)
      t = lap('sources', t)

      progress(0.2, 'Ranking packs')
      const base = this.#o.packs.base
      const baseManifests = base.manifests.filter((m) => m.id !== LIVE_PACK)
      const scores = rankItems(baseManifests, signals)
      t = lap('rank', t)

      const cat = buildCatalogue(baseManifests, base.index)
      const previous = this.#o.packs.overlay.manifest
      const taken = new Set<string>(
        previous
          ? (
              [
                'captionStyles',
                'textPresets',
                'templates',
                'filters',
                'animations',
                'effects',
              ] as const
            ).flatMap((c) => (previous[c] as Array<{ id: string }>).map((i) => i.id))
          : [],
      )
      const remixed = remixTemplates(cat, signals, taken)
      progress(0.3, 'Writing new presets')
      let llmUsed = false
      let gen = undefined as Awaited<ReturnType<typeof llmGenerate>> | undefined
      if (await this.#o.llm.available().catch(() => false)) {
        gen = await llmGenerate({ llm: this.#o.llm, cat, signals, taken, signal })
        llmUsed = gen.captionStyles.length + gen.textPresets.length + gen.templates.length > 0
      }
      t = lap('generate', t)

      progress(0.6, 'Validating and rendering thumbnails')
      const createdAt = new Map(this.#state.items.map((i) => [i.ref, i.createdAt]))
      const iso = now.toISOString()
      const fresh = {
        captionStyles: gen?.captionStyles.map((g) => g.item) ?? [],
        textPresets: gen?.textPresets.map((g) => g.item) ?? [],
        // Generated templates first: they are the reason this pack exists.
        templates: [...(gen?.templates.map((g) => g.item) ?? []), ...remixed.map((r) => r.item)],
      }
      const origins = new Map<string, Origin>(
        [
          ...(gen?.captionStyles ?? []),
          ...(gen?.textPresets ?? []),
          ...(gen?.templates ?? []),
          ...remixed,
        ].map((g) => [`${LIVE_PACK}/${g.item.id}`, g.origin]),
      )
      for (const ref of origins.keys()) createdAt.set(ref, iso)
      const built = await buildLivePack({
        root: localPacksRoot(this.#o.dataRoot),
        base: { manifests: baseManifests, index: base.index, dir: base.dir },
        previous,
        previousDir: this.#o.packs.overlay.dir,
        createdAt,
        fresh,
        now,
        ffmpeg: this.#o.ffmpeg,
        log: this.#o.log,
        signal,
        ...(this.#o.skipThumbs ? { skipThumbs: true } : {}),
      })
      ms.validate = built.ms.validate
      ms.thumbs = built.ms.thumbs
      t = lap('pack', t)

      // Item info: carried items keep their origin/creation time; new ones get today's.
      const prevInfo = new Map(this.#state.items.map((i) => [i.ref, i]))
      const items: GeneratedItemInfo[] = []
      for (const c of ['templates', 'textPresets', 'captionStyles'] as const)
        for (const item of built.manifest[c]) {
          const ref = `${LIVE_PACK}/${item.id}`
          const origin = origins.get(ref)
          const prev = prevInfo.get(ref)
          if (origin && built.added.includes(ref))
            items.push({
              ref,
              collection: c,
              name: item.name,
              trend: origin.trend,
              kind: origin.kind,
              createdAt: iso,
            })
          else if (prev) items.push(prev)
        }

      this.#o.packs.setOverlay({ manifest: built.manifest, dir: built.dir, scores })

      progress(0.85, 'Writing reel ideas')
      const templatePool: Array<{ ref: string; item: TemplatePreset }> = [
        ...built.manifest.templates.map((item) => ({ ref: `${LIVE_PACK}/${item.id}`, item })),
        ...baseManifests.flatMap((m) =>
          m.templates.map((item) => ({ ref: `${m.id}/${item.id}`, item })),
        ),
      ]
      const topics = topOf(signals, 'topic', IDEA_TOPICS).map((s) => s.text)
      const ideas = await reelIdeas({
        llm: gen ? this.#o.llm : undefined,
        topics,
        templates: templatePool,
        signals,
        signal,
      })
      t = lap('ideas', t)

      const hashtags = [
        ...new Set([...(gen?.hashtags ?? []), ...topOf(signals, 'hashtag', 20).map((s) => s.text)]),
      ].slice(0, 30)
      const llmErrors = [...(gen?.errors ?? []), ...(ideas.error ? [`ideas: ${ideas.error}`] : [])]
      const seen: Record<string, string> = {}
      for (const x of soundsOf(signals, 30)) {
        const k = normalize(x.title)
        seen[k] = this.#state.soundsSeen?.[k] ?? iso
      }
      this.#state = {
        ...this.#state,
        soundsSeen: seen,
        generatedAt: iso,
        signals: signals.slice(0, 200),
        scores: [...scores],
        items,
        hashtags,
        ideas: ideas.ideas,
        llm: {
          used: llmUsed || ideas.usedLlm,
          ...(gen?.tokensPerSecond ? { tokensPerSecond: gen.tokensPerSecond } : {}),
          ...(llmErrors.length ? { errors: llmErrors } : {}),
        },
        dropped: built.dropped,
        ms: { ...ms, total: Math.round(performance.now() - t0) },
      }
      delete this.#state.lastError
      await this.#save()

      if (this.settings().autoPublish && this.#o.config.publish === 'github') {
        progress(0.95, 'Publishing')
        await this.#publish(built.manifest, built.dir)
      }
      this.#o.log.info(
        { ms: this.#state.ms, items: items.length, dropped: built.dropped.length, llm: llmUsed },
        'trends refreshed',
      )
      return this.#state
    } catch (err) {
      if (!signal.aborted) {
        this.#state.lastError = (err as Error).message
        await this.#save().catch(() => undefined)
      }
      throw err
    }
  }

  async #publish(manifest: PackManifest, dir: string): Promise<void> {
    const at = this.#now().toISOString()
    try {
      const repo = this.#o.config.publishRepo
      if (!repo) throw new Error('set PUBLISH_TRENDS_REPO (owner/name)')
      const res: PublishResult = await publishLivePack({
        repo,
        mode: this.#o.config.publishMode,
        manifest,
        dir,
        ...(this.#o.exec ? { exec: this.#o.exec } : {}),
      })
      this.#state.publish =
        res.status === 'published'
          ? { at, status: `published (${res.mode})`, ...(res.prUrl ? { url: res.prUrl } : {}) }
          : { at, status: 'skipped', error: res.reason }
    } catch (err) {
      this.#o.log.warn({ err }, 'trend pack publish failed')
      this.#state.publish = { at, status: 'failed', error: (err as Error).message }
    }
    await this.#save()
  }

  /* ------------------------------------------------------------------ on-demand ideas */

  /** A reel idea for any topic (cached; LLM when available, else template-based). */
  async ideaFor(topic: string, signal: AbortSignal): Promise<ReelIdea> {
    const key = normalize(topic)
    const cached = this.#state.ideas.find((i) => normalize(i.topic) === key)
    if (cached) return cached
    const llmOk = await this.#o.llm.available().catch(() => false)
    const snap = this.#o.packs.snapshot
    const templates = snap.manifests
      .flatMap((m) => m.templates.map((item) => ({ ref: `${m.id}/${item.id}`, item })))
      .sort(
        (a, b) =>
          Number(b.ref.startsWith(`${LIVE_PACK}/`)) - Number(a.ref.startsWith(`${LIVE_PACK}/`)),
      )
    const { ideas } = await reelIdeas({
      llm: llmOk ? this.#o.llm : undefined,
      topics: [key],
      templates,
      signals: this.#state.signals,
      signal,
    })
    const idea = ideas[0]!
    this.#state.ideas = [...this.#state.ideas, idea].slice(-MAX_IDEAS)
    await this.#save()
    return idea
  }

  /** Whether synced trending-sound previews are enabled on this host (opt-in). */
  get soundPreview(): boolean {
    return this.#o.config.soundPreview === true
  }

  /** Today's trending sounds as profiles for trend-matched music (best first). */
  soundProfiles(n = 8): TrendSoundProfile[] {
    return soundsOf(this.#state.signals, n).map(soundProfile)
  }

  /** Summary for `GET /api/trends`. */
  summary(): TrendsSummary {
    const s = this.#state
    const now = this.#now()
    const fresh = (iso: string) => now.getTime() - Date.parse(iso) < 36 * 3_600_000
    const live = this.#o.packs.overlay.manifest
    const liveIds = new Set(
      live
        ? [...live.templates, ...live.textPresets, ...live.captionStyles].map(
            (i) => `${LIVE_PACK}/${i.id}`,
          )
        : [],
    )
    const signals = (kind: TrendSignal['kind'], n: number) =>
      topOf(s.signals, kind, n).map((x) => ({ text: x.text, weight: x.weight, sources: x.sources }))
    return {
      enabled: this.#o.config.enabled,
      generatedAt: s.generatedAt ?? null,
      lastAttemptAt: s.lastAttemptAt ?? null,
      lastError: s.lastError ?? null,
      stale: this.stale(now),
      running:
        this.running ||
        (this.#activeJobId !== undefined && this.#queue?.active(this.#activeJobId) !== undefined),
      nextRunAt: this.#o.config.enabled ? this.nextRunAt(now) : null,
      sources: s.sources,
      topics: signals('topic', 20),
      hashtags: s.hashtags.slice(0, 24),
      formats: signals('format', 10),
      aesthetics: signals('aesthetic', 10),
      sounds: soundsOf(s.signals, 12).map((x) => {
        const sig = topOf(s.signals, 'sound', 12).find(
          (y) => normalize(y.text) === normalize(x.title),
        )
        const firstSeen = s.soundsSeen?.[normalize(x.title)]
        return {
          ...x,
          ...soundFeel(x),
          ...(firstSeen ? { firstSeen } : {}),
          fresh: firstSeen ? fresh(firstSeen) : false,
          sources: sig?.sources ?? [],
          link: `https://www.deezer.com/search/${encodeURIComponent(`${x.title} ${x.artist ?? ''}`.trim())}`,
        }
      }),
      items: s.items
        .filter((i) => liveIds.has(i.ref))
        .map((i) => ({ ...i, fresh: fresh(i.createdAt) })),
      ideas: s.ideas,
      llm: s.llm,
      settings: this.settings(),
      publishAvailable: this.#o.config.publish === 'github',
      soundPreview: this.soundPreview,
      publish: s.publish ?? null,
      ms: s.ms ?? null,
    }
  }
}

export interface TrendsSummary {
  enabled: boolean
  generatedAt: string | null
  lastAttemptAt: string | null
  lastError: string | null
  stale: boolean
  running: boolean
  nextRunAt: string | null
  sources: SourceStatus[]
  topics: Array<{ text: string; weight: number; sources: string[] }>
  hashtags: string[]
  formats: Array<{ text: string; weight: number; sources: string[] }>
  aesthetics: Array<{ text: string; weight: number; sources: string[] }>
  sounds: Array<{
    title: string
    artist?: string | undefined
    bpm: number
    measured: boolean
    weight: number
    genre?: string | undefined
    mood: MusicMood
    energy: number
    /** First seen on a chart (ISO) and whether that was within 36 h. */
    firstSeen?: string
    fresh: boolean
    sources: string[]
    link: string
  }>
  items: Array<GeneratedItemInfo & { fresh: boolean }>
  ideas: ReelIdea[]
  llm: TrendsState['llm']
  settings: TrendsSettings
  publishAvailable: boolean
  /** Synced previews of trending sounds are enabled (TRENDS_SOUND_PREVIEW=1). */
  soundPreview: boolean
  publish: TrendsState['publish'] | null
  ms: Record<string, number> | null
}

/** The `trends` job: one refresh, low priority, in the AI resource class. */
export const trendsJob = (service: () => TrendsService | undefined): JobDefinition => ({
  kind: 'trends',
  resource: 'ai',
  defaultPriority: 200,
  handler: async (ctx) => {
    const s = service()
    if (!s) throw new Error('trend engine is not running')
    const state = await s.refresh(ctx.signal, (p, m) => ctx.progress(p, m))
    return { generatedAt: state.generatedAt, items: state.items.length, ms: state.ms }
  },
})
