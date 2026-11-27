/**
 * Trend packs: loading, serving and auto-sync from PACKS_URL (raw GitHub by default).
 *
 * On-disk layout under `<data>/packs`:
 *   active.json            → { dir, version, etag } — the pointer that is swapped atomically
 *   <dir>/index.json       → PackIndex
 *   <dir>/<packId>/…       → pack.json + LUTs / stickers / thumbs
 *   <dir>/fonts/<Family>/… → fonts
 *
 * Sync builds a complete new tree in a staging directory (unchanged files are hard-linked from
 * the active tree, changed ones downloaded and sha256-verified), validates it with the core
 * schemas, then flips `active.json` with a rename. Readers (HTTP, FFmpeg exports holding a LUT
 * open) keep using the old tree until it is garbage-collected on a later sync — on Windows a
 * directory with open files cannot be renamed or deleted, so swapping a pointer instead of
 * directories is what makes the update atomic AND safe under load. With nothing synced the
 * repository's `./packs` is used (dev / offline installs).
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {
  PackIndex,
  PackManifest,
  type AnimationPreset,
  type PackFile,
  type TemplatePreset,
} from '@reelforge/core'
import type { Logger } from '../contracts.ts'
import type { EventBus } from '../jobs/events.ts'
import { compareVersions, encodePath, isSafePackId, resolveInside, safeSegments } from './files.ts'

export interface PacksSnapshot {
  index: PackIndex | undefined
  manifests: PackManifest[]
  /** Where the packs come from: synced copy, the repo's bundled ./packs, or nothing. */
  source: 'synced' | 'bundled' | 'none'
  dir: string | undefined
}

export type SyncResult =
  | { status: 'updated'; version: string; downloaded: number; reused: number; ms: number }
  | { status: 'unchanged'; version: string | undefined }
  | { status: 'skipped'; reason: string }

export interface PacksServiceOptions {
  /** `<data>/packs` */
  root: string
  /** Repository `./packs` fallback. */
  bundledDir?: string | undefined
  /** Base URL serving `index.json`, `<packId>/pack.json`, files and `fonts/…`. */
  url: string
  appVersion: string
  log: Logger
  bus?: EventBus
  fetch?: typeof fetch
  /** Parallel downloads. */
  concurrency?: number
  requestTimeoutMs?: number
}

/**
 * A locally generated pack served on top of the synced/bundled tree (the trend engine's
 * `trending-live`), plus live `trendScore` overrides (`<packId>/<itemId>` → score) that
 * re-rank existing items without touching their hash-verified files.
 */
export interface PacksOverlay {
  manifest?: PackManifest | undefined
  /** Directory holding the overlay pack's files (`<dir>/<file path>`). */
  dir?: string | undefined
  scores?: ReadonlyMap<string, number> | undefined
}

interface ActivePointer {
  dir: string
  version: string
  etag?: string
}

export class PackSyncError extends Error {}

const sha256File = (file: string): Promise<{ sha256: string; size: number }> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let size = 0
    createReadStream(file)
      .on('data', (c) => {
        const b = c as Buffer
        size += b.length
        hash.update(b)
      })
      .once('error', reject)
      .once('end', () => resolve({ sha256: hash.digest('hex'), size }))
  })

/** Runs `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
/**
 * Runs `fn` over `items` with at most `limit` in flight. After the first failure no new item
 * starts, and the error is thrown only once every in-flight item has settled — so callers can
 * safely delete the files those items were writing.
 */
const pool = async <T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) => {
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      try {
        await fn(items[next++]!)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )
  const rejected = results.find((r) => r.status === 'rejected')
  if (rejected) throw rejected.reason
}

/** Reads and validates a pack tree. Invalid manifests are skipped (and logged), never fatal. */
export const loadPackTree = async (
  dir: string,
  log?: Logger,
): Promise<{ index: PackIndex; manifests: PackManifest[] } | undefined> => {
  let raw: string
  try {
    raw = await readFile(path.join(dir, 'index.json'), 'utf8')
  } catch {
    return undefined
  }
  const index = PackIndex.parse(JSON.parse(raw))
  const manifests: PackManifest[] = []
  await Promise.all(
    index.packs.map(async (entry) => {
      if (!isSafePackId(entry.id)) return
      try {
        const text = await readFile(path.join(dir, entry.id, 'pack.json'), 'utf8')
        manifests.push(PackManifest.parse(JSON.parse(text)))
      } catch (err) {
        log?.warn({ pack: entry.id, err }, 'skipping invalid pack')
      }
    }),
  )
  // Keep index order (Promise.all completion order is not deterministic).
  const order = new Map(index.packs.map((p, i) => [p.id, i]))
  manifests.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return { index, manifests }
}

export class PacksService {
  readonly #o: PacksServiceOptions
  readonly #fetch: typeof fetch
  #snapshot: PacksSnapshot = { index: undefined, manifests: [], source: 'none', dir: undefined }
  #pointer: ActivePointer | undefined
  #syncing: Promise<SyncResult> | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #overlay: PacksOverlay = {}
  #merged: PacksSnapshot | undefined

  constructor(opts: PacksServiceOptions) {
    this.#o = opts
    this.#fetch = opts.fetch ?? fetch
  }

  /** Loads the synced packs (or the bundled fallback) into memory. */
  async init(): Promise<PacksSnapshot> {
    this.#merged = undefined
    await mkdir(this.#o.root, { recursive: true })
    try {
      this.#pointer = JSON.parse(
        await readFile(path.join(this.#o.root, 'active.json'), 'utf8'),
      ) as ActivePointer
    } catch {
      this.#pointer = undefined
    }
    if (this.#pointer && isSafePackId(this.#pointer.dir)) {
      const dir = path.join(this.#o.root, this.#pointer.dir)
      try {
        const tree = await loadPackTree(dir, this.#o.log)
        if (tree) {
          this.#snapshot = { ...tree, source: 'synced', dir }
          return this.#snapshot
        }
      } catch (err) {
        this.#o.log.warn({ err }, 'synced packs are invalid; falling back to bundled packs')
      }
    }
    this.#pointer = undefined
    if (this.#o.bundledDir) {
      try {
        const tree = await loadPackTree(this.#o.bundledDir, this.#o.log)
        if (tree) {
          this.#snapshot = { ...tree, source: 'bundled', dir: this.#o.bundledDir }
          return this.#snapshot
        }
      } catch (err) {
        this.#o.log.warn({ err }, 'bundled packs are invalid')
      }
    }
    this.#snapshot = { index: undefined, manifests: [], source: 'none', dir: undefined }
    return this.#snapshot
  }

  /** The served view: the active tree plus the overlay pack and live trend scores. */
  get snapshot(): PacksSnapshot {
    this.#merged ??= mergeOverlay(this.#snapshot, this.#overlay)
    return this.#merged
  }

  /** The synced/bundled tree alone (no overlay). */
  get base(): PacksSnapshot {
    return this.#snapshot
  }

  get overlay(): PacksOverlay {
    return this.#overlay
  }

  /** Replaces the overlay; `emit` announces the change to clients like a sync does. */
  setOverlay(overlay: PacksOverlay, emit = true): void {
    if (overlay.manifest && !isSafePackId(overlay.manifest.id))
      throw new Error(`unsafe overlay pack id: ${overlay.manifest.id}`)
    this.#overlay = overlay
    this.#merged = undefined
    if (emit) this.#o.bus?.emit({ type: 'packs', version: this.version ?? 'none' })
  }

  /** Directory of the active pack tree (`DataPaths.packs` for jobs). */
  get dir(): string | undefined {
    return this.#snapshot.dir
  }

  /** Served version: changes with the tree, the overlay pack and the live scores. */
  get version(): string | undefined {
    return this.snapshot.index?.version
  }

  /** Absolute path of a pack file (`<packId>/luts/x.cube`, `fonts/…`) or undefined if unsafe. */
  resolveFile(rel: string): string | undefined {
    const { manifest, dir } = this.#overlay
    if (manifest && dir && rel.startsWith(`${manifest.id}/`))
      return resolveInside(dir, rel.slice(manifest.id.length + 1))
    return this.#snapshot.dir ? resolveInside(this.#snapshot.dir, rel) : undefined
  }

  #findItem<K extends 'animations' | 'templates'>(
    key: K,
    ref: string,
  ): PackManifest[K][number] | undefined {
    const slash = ref.indexOf('/')
    if (slash <= 0) return undefined
    const pack = this.snapshot.manifests.find((m) => m.id === ref.slice(0, slash))
    const id = ref.slice(slash + 1)
    return (pack?.[key] as Array<{ id: string }> | undefined)?.find((i) => i.id === id) as
      PackManifest[K][number] | undefined
  }

  /** `<packId>/<animationId>` → preset. */
  findAnimation(ref: string): AnimationPreset | undefined {
    return this.#findItem('animations', ref)
  }

  /** `<packId>/<templateId>` → template. */
  findTemplate(ref: string): TemplatePreset | undefined {
    return this.#findItem('templates', ref)
  }

  /** Starts periodic sync (plus one right away). `intervalMs` 0 = startup sync only. */
  start(intervalMs: number): void {
    this.stop()
    const tick = (): void => {
      this.sync().catch((err: unknown) => this.#o.log.warn({ err }, 'pack sync failed'))
    }
    tick()
    if (intervalMs > 0) {
      this.#timer = setInterval(tick, intervalMs)
      this.#timer.unref()
    }
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** Waits for an in-flight sync (shutdown). */
  async idle(): Promise<void> {
    await this.#syncing?.catch(() => undefined)
  }

  /** Syncs now. Concurrent callers share the same in-flight sync. */
  sync(): Promise<SyncResult> {
    this.#syncing ??= this.#sync().finally(() => {
      this.#syncing = undefined
    })
    return this.#syncing
  }

  async #get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await this.#fetch(url, {
      headers: { 'user-agent': `ReelForge/${this.#o.appVersion}`, ...headers },
      signal: AbortSignal.timeout(this.#o.requestTimeoutMs ?? 60_000),
      redirect: 'follow',
    })
    if (res.status !== 304 && !res.ok) {
      await res.body?.cancel()
      throw new PackSyncError(`GET ${url} → HTTP ${res.status}`)
    }
    return res
  }

  /** Streams `url` into `dest`, verifying size and sha256 as bytes arrive. */
  async #download(url: string, dest: string, expect: PackFile): Promise<void> {
    const res = await this.#get(url)
    if (!res.body) throw new PackSyncError(`empty body: ${url}`)
    await mkdir(path.dirname(dest), { recursive: true })
    const hash = createHash('sha256')
    let size = 0
    const fh = await open(dest, 'w')
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength
        if (size > expect.size) throw new PackSyncError(`size mismatch for ${expect.path}`)
        hash.update(chunk)
        await fh.write(chunk)
      }
    } finally {
      await fh.close()
    }
    const sha = hash.digest('hex')
    if (size !== expect.size) throw new PackSyncError(`size mismatch for ${expect.path}`)
    if (sha !== expect.sha256) throw new PackSyncError(`sha256 mismatch for ${expect.path}`)
  }

  /** Hard-links (or copies) a verified file from the active tree; false if unavailable. */
  async #reuse(from: string | undefined, dest: string, expect: PackFile): Promise<boolean> {
    if (!from) return false
    try {
      const actual = await sha256File(from)
      if (actual.sha256 !== expect.sha256 || actual.size !== expect.size) return false
      await mkdir(path.dirname(dest), { recursive: true })
      await link(from, dest).catch(() => copyFile(from, dest))
      return true
    } catch {
      return false
    }
  }

  async #sync(): Promise<SyncResult> {
    const t0 = performance.now()
    const base = this.#o.url
    const synced = this.#snapshot.source === 'synced' ? this.#snapshot : undefined
    const headers: Record<string, string> = {}
    if (synced && this.#pointer?.etag) headers['if-none-match'] = this.#pointer.etag
    const res = await this.#get(`${base}/index.json`, headers)
    if (res.status === 304) return { status: 'unchanged', version: this.#snapshot.index?.version }
    const indexText = await res.text()
    const index = PackIndex.parse(JSON.parse(indexText))
    const etag = res.headers.get('etag') ?? undefined
    if (compareVersions(index.minAppVersion, this.#o.appVersion) > 0)
      return {
        status: 'skipped',
        reason: `packs ${index.version} need ReelForge ${index.minAppVersion}+`,
      }
    if (synced?.index?.version === index.version) {
      if (etag && this.#pointer) await this.#writePointer({ ...this.#pointer, etag })
      return { status: 'unchanged', version: index.version }
    }

    const oldDir = synced?.dir
    const oldManifests = new Map((synced?.manifests ?? []).map((m) => [m.id, m]))
    const staging = await mkdtemp(path.join(this.#o.root, '.staging-'))
    let downloaded = 0
    let reused = 0
    try {
      // 1. Manifests (small; needed to know which files to fetch).
      const manifests: Array<{ manifest: PackManifest; text: string; old?: PackManifest }> = []
      await pool(index.packs, this.#o.concurrency ?? 6, async (entry) => {
        if (!isSafePackId(entry.id)) throw new PackSyncError(`unsafe pack id: ${entry.id}`)
        const old = oldManifests.get(entry.id)
        let text: string
        if (old && old.version === entry.version && oldDir)
          text = await readFile(path.join(oldDir, entry.id, 'pack.json'), 'utf8')
        else text = await (await this.#get(`${base}/${encodePath(entry.id)}/pack.json`)).text()
        const manifest = PackManifest.parse(JSON.parse(text))
        if (manifest.id !== entry.id)
          throw new PackSyncError(
            `pack.json id ${manifest.id} does not match index entry ${entry.id}`,
          )
        manifests.push(old ? { manifest, text, old } : { manifest, text })
      })

      // 2. Every file: reuse from the active tree when the hash matches, else download.
      interface Task {
        rel: string
        url: string
        file: PackFile
        from: string | undefined
      }
      const tasks: Task[] = []
      const oldFonts = new Map(
        (synced?.index?.fonts ?? []).flatMap((f) => f.files.map((x) => [x.path, x.sha256])),
      )
      for (const { manifest, old } of manifests) {
        const oldFiles = new Map((old?.files ?? []).map((f) => [f.path, f.sha256]))
        for (const file of manifest.files) {
          if (!safeSegments(file.path))
            throw new PackSyncError(`unsafe file path in ${manifest.id}: ${file.path}`)
          const rel = `${manifest.id}/${file.path}`
          tasks.push({
            rel,
            url: `${base}/${encodePath(rel)}`,
            file,
            from:
              oldDir && oldFiles.get(file.path) === file.sha256
                ? path.join(oldDir, rel)
                : undefined,
          })
        }
      }
      for (const family of index.fonts)
        for (const file of family.files) {
          if (!safeSegments(file.path)) throw new PackSyncError(`unsafe font path: ${file.path}`)
          tasks.push({
            rel: file.path,
            url: `${base}/${encodePath(file.path)}`,
            file,
            from:
              oldDir && oldFonts.get(file.path) === file.sha256
                ? path.join(oldDir, file.path)
                : undefined,
          })
        }
      await pool(tasks, this.#o.concurrency ?? 6, async (task) => {
        const dest = path.join(staging, ...task.rel.split('/'))
        if (await this.#reuse(task.from, dest, task.file)) reused++
        else {
          await this.#download(task.url, dest, task.file)
          downloaded++
        }
      })
      await Promise.all(
        manifests.map(async ({ manifest, text }) => {
          await mkdir(path.join(staging, manifest.id), { recursive: true })
          await writeFile(path.join(staging, manifest.id, 'pack.json'), text)
        }),
      )
      await writeFile(path.join(staging, 'index.json'), indexText)

      // 3. Validate the finished tree exactly as it will be loaded, then flip the pointer.
      const tree = await loadPackTree(staging, this.#o.log)
      if (!tree || tree.manifests.length !== index.packs.length)
        throw new PackSyncError('staged packs failed validation')
      const dirName = `v-${Date.now().toString(36)}`
      await rename(staging, path.join(this.#o.root, dirName))
      const pointer: ActivePointer = { dir: dirName, version: index.version }
      if (etag) pointer.etag = etag
      await this.#writePointer(pointer)
      this.#snapshot = { ...tree, source: 'synced', dir: path.join(this.#o.root, dirName) }
      this.#merged = undefined
    } catch (err) {
      // Never let a cleanup failure (e.g. a file still locked on Windows) mask the real error;
      // a leftover staging dir is collected by the next sync.
      await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch((rmErr: unknown) =>
        this.#o.log.debug({ err: rmErr }, 'could not remove staging dir'),
      )
      throw err
    }
    await this.#collectGarbage()
    this.#o.bus?.emit({ type: 'packs', version: this.version ?? index.version })
    const ms = Math.round(performance.now() - t0)
    this.#o.log.info({ version: index.version, downloaded, reused, ms }, 'packs updated')
    return { status: 'updated', version: index.version, downloaded, reused, ms }
  }

  async #writePointer(pointer: ActivePointer): Promise<void> {
    const file = path.join(this.#o.root, 'active.json')
    await writeFile(`${file}.tmp`, JSON.stringify(pointer))
    await rename(`${file}.tmp`, file)
    this.#pointer = pointer
  }

  /** Removes inactive trees; ones still in use (open files on Windows) are retried next sync. */
  async #collectGarbage(): Promise<void> {
    const active = this.#pointer?.dir
    for (const entry of await readdir(this.#o.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === active) continue
      // Only one sync runs at a time and its staging dir was renamed already, so any
      // `.staging-*` left here is from a crashed run.
      if (!entry.name.startsWith('v-') && !entry.name.startsWith('.staging-')) continue
      await rm(path.join(this.#o.root, entry.name), { recursive: true, force: true }).catch(
        (err: unknown) => this.#o.log.debug({ err, dir: entry.name }, 'old pack tree still in use'),
      )
    }
  }
}

/** Short non-cryptographic hash (FNV-1a, base 36) for overlay version tags. */
const hash36 = (text: string): string => {
  let h = 2_166_136_261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16_777_619)
  return (h >>> 0).toString(36)
}

const ITEM_COLLECTIONS = [
  'captionStyles',
  'textPresets',
  'filters',
  'animations',
  'transitions',
  'effects',
  'stickers',
  'templates',
] as const

/** Applies an overlay to a tree snapshot. Pure: the base snapshot is never mutated. */
export const mergeOverlay = (base: PacksSnapshot, overlay: PacksOverlay): PacksSnapshot => {
  const { manifest, scores } = overlay
  if (!manifest && !scores?.size) return base
  const rescore = (m: PackManifest): PackManifest => {
    if (!scores?.size) return m
    const out: Record<string, unknown> = { ...m }
    for (const c of ITEM_COLLECTIONS)
      out[c] = (m[c] as Array<{ id: string; trendScore: number }>).map((item) => {
        const s = scores.get(`${m.id}/${item.id}`)
        return s === undefined || s === item.trendScore ? item : { ...item, trendScore: s }
      })
    return out as PackManifest
  }
  const manifests = base.manifests.filter((m) => m.id !== manifest?.id).map(rescore)
  if (manifest) manifests.push(rescore(manifest))
  const scoreTag = scores?.size ? hash36([...scores].map(([k, v]) => `${k}=${v}`).join()) : '0'
  const packTag = manifest ? hash36(JSON.stringify(manifest)) : '0'
  const tag = `live.${packTag}.${scoreTag}`
  const entry = manifest && {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    curatedAt: manifest.curatedAt,
    tags: ['live'],
  }
  const index: PackIndex = base.index
    ? {
        ...base.index,
        version: `${base.index.version}-${tag}`,
        packs: [
          ...base.index.packs.filter((p) => p.id !== manifest?.id),
          ...(entry ? [entry] : []),
        ],
      }
    : {
        version: `0.0.0-${tag}`,
        updatedAt: manifest?.curatedAt ?? '1970-01-01',
        minAppVersion: '0.1.0',
        packs: entry ? [entry] : [],
        fonts: [],
      }
  return { ...base, index, manifests }
}
