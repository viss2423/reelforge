/**
 * SQLite-backed `Store` on Node's built-in `node:sqlite` (synchronous, zero native deps).
 *
 * Why synchronous: every statement here is an indexed point lookup or a small write that
 * completes in microseconds under WAL; an async driver would add more scheduling overhead
 * than it saves. Documents (projects, assets, jobs) are stored as JSON with the columns we
 * filter/sort on denormalised next to them. All statements are prepared once.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  projectDuration,
  type Asset,
  type Job,
  type JobStatus,
  type Project,
} from '@reelforge/core'
import { RevisionConflictError, type Store } from '../contracts.ts'
import { migrate } from './migrations.ts'

export interface DeviceRecord {
  id: string
  name: string
  userAgent?: string
  createdAt: string
  lastSeenAt: string
}

export interface UploadRecord {
  id: string
  name: string
  mime: string
  size: number
  chunkSize: number
  chunks: number
  /** Bitmap of received chunks (bit i of byte i>>3). */
  received: Uint8Array
  deviceId?: string
  createdAt: string
  updatedAt: string
}

export interface JobRecord {
  job: Job
  payload: unknown
  priority: number
  attempts: number
  seq: number
}

export type ProjectSummary = ReturnType<Store['listProjects']>[number]

const ACTIVE: readonly JobStatus[] = ['queued', 'running']
const FINISHED: readonly JobStatus[] = ['done', 'failed', 'cancelled']

const thumbAssetOf = (project: Project): string | undefined => {
  const main = project.tracks.find((t) => t.kind === 'main')
  for (const clip of main?.clips ?? [])
    if (clip.type === 'video' || clip.type === 'image') return clip.assetId
  return undefined
}

const popcount = (bits: Uint8Array): number => {
  let n = 0
  for (let b of bits) {
    while (b) {
      b &= b - 1
      n++
    }
  }
  return n
}

/** Indices of set bits in a received-chunks bitmap. */
export const bitmapIndices = (bits: Uint8Array, count: number): number[] => {
  const out: number[] = []
  for (let i = 0; i < count; i++) if ((bits[i >> 3]! >> (i & 7)) & 1) out.push(i)
  return out
}

type Row = Record<string, unknown>
/** SQLite TEXT column → string; NULL → undefined. */
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export class SqliteStore implements Store {
  readonly db: DatabaseSync
  readonly #s: Record<string, StatementSync>
  #seq = 0

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    // WAL: readers never block the writer; NORMAL sync is crash-safe in WAL mode (at most the
    // last transaction is lost on power failure) and avoids an fsync per commit.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -16000;
    `)
    migrate(this.db)
    const p = (sql: string): StatementSync => this.db.prepare(sql)
    this.#s = {
      getProject: p('SELECT data FROM projects WHERE id = ?'),
      projectRevision: p('SELECT revision FROM projects WHERE id = ?'),
      listProjects: p(
        'SELECT id, name, created_at, updated_at, duration, thumb_asset_id FROM projects ORDER BY updated_at DESC',
      ),
      upsertProject:
        p(`INSERT INTO projects (id, name, revision, created_at, updated_at, duration, thumb_asset_id, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, revision = excluded.revision,
          updated_at = excluded.updated_at, duration = excluded.duration,
          thumb_asset_id = excluded.thumb_asset_id, data = excluded.data`),
      deleteProject: p('DELETE FROM projects WHERE id = ?'),
      getAsset: p('SELECT data FROM assets WHERE id = ?'),
      listAssets: p('SELECT data FROM assets ORDER BY created_at DESC'),
      putAsset: p(
        'INSERT INTO assets (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data',
      ),
      deleteAsset: p('DELETE FROM assets WHERE id = ?'),
      getJob: p('SELECT data, payload, priority, attempts, seq FROM jobs WHERE id = ?'),
      listJobsAll: p('SELECT data FROM jobs ORDER BY created_at DESC, seq DESC LIMIT ?'),
      maxSeq: p('SELECT COALESCE(MAX(seq), 0) AS seq FROM jobs'),
      insertJob:
        p(`INSERT INTO jobs (id, seq, kind, status, priority, attempts, project_id, asset_id, created_at, finished_at, payload, data)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`),
      updateJob: p(
        'UPDATE jobs SET status = ?, finished_at = ?, project_id = ?, asset_id = ?, data = ? WHERE id = ?',
      ),
      setAttempts: p('UPDATE jobs SET attempts = ? WHERE id = ?'),
      jobsByStatus: p(
        'SELECT data, payload, priority, attempts, seq FROM jobs WHERE status = ? ORDER BY priority, seq',
      ),
      finishedBefore: p(
        "SELECT id, kind, finished_at FROM jobs WHERE status IN ('done','failed','cancelled') AND finished_at < ?",
      ),
      deleteJob: p('DELETE FROM jobs WHERE id = ?'),
      getSetting: p('SELECT value FROM settings WHERE key = ?'),
      setSetting: p(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ),
      deleteSetting: p('DELETE FROM settings WHERE key = ?'),
      insertDevice: p(
        'INSERT INTO devices (id, name, token_hash, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      deviceByHash: p(
        'SELECT id, name, user_agent, created_at, last_seen_at FROM devices WHERE token_hash = ?',
      ),
      listDevices: p(
        'SELECT id, name, user_agent, created_at, last_seen_at FROM devices ORDER BY last_seen_at DESC',
      ),
      deleteDevice: p('DELETE FROM devices WHERE id = ?'),
      touchDevice: p('UPDATE devices SET last_seen_at = ? WHERE id = ?'),
      insertUpload:
        p(`INSERT INTO uploads (id, name, mime, size, chunk_size, chunks, received, device_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      getUpload: p('SELECT * FROM uploads WHERE id = ?'),
      setReceived: p('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?'),
      deleteUpload: p('DELETE FROM uploads WHERE id = ?'),
      listUploads: p('SELECT * FROM uploads ORDER BY created_at'),
    }
    this.#seq = Number((this.#s.maxSeq!.get() as Row).seq)
  }

  #stmt(name: string): StatementSync {
    return this.#s[name]!
  }

  /** Runs `fn` in a transaction (committed if it returns, rolled back if it throws). */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  /* ------------------------------------------------------------ projects */

  getProject(id: string): Project | undefined {
    const row = this.#stmt('getProject').get(id) as Row | undefined
    return row ? (JSON.parse(String(row.data)) as Project) : undefined
  }

  listProjects(): ProjectSummary[] {
    return (this.#stmt('listProjects').all() as Row[]).map((r) => {
      const summary: ProjectSummary = {
        id: String(r.id),
        name: String(r.name),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        duration: Number(r.duration),
      }
      const thumb = str(r.thumb_asset_id)
      if (thumb) summary.thumbAssetId = thumb
      return summary
    })
  }

  /**
   * Optimistic concurrency: a project that does not exist yet has revision 0. The stored
   * document's `revision` is set to the returned new revision.
   */
  saveProject(project: Project, expectedRevision: number): number {
    return this.transaction(() => {
      const row = this.#stmt('projectRevision').get(project.id) as Row | undefined
      const current = row ? Number(row.revision) : 0
      if (current !== expectedRevision) throw new RevisionConflictError(current)
      const revision = current + 1
      const doc: Project = { ...project, revision }
      this.#stmt('upsertProject').run(
        doc.id,
        doc.name,
        revision,
        doc.createdAt,
        doc.updatedAt,
        // Core's definition: transition-overlap-adjusted main track or latest clip elsewhere.
        projectDuration(doc),
        thumbAssetOf(doc) ?? null,
        JSON.stringify(doc),
      )
      return revision
    })
  }

  deleteProject(id: string): void {
    this.#stmt('deleteProject').run(id)
  }

  /* ------------------------------------------------------------ assets */

  getAsset(id: string): Asset | undefined {
    const row = this.#stmt('getAsset').get(id) as Row | undefined
    return row ? (JSON.parse(String(row.data)) as Asset) : undefined
  }

  listAssets(): Asset[] {
    return (this.#stmt('listAssets').all() as Row[]).map((r) => JSON.parse(String(r.data)) as Asset)
  }

  putAsset(asset: Asset): void {
    this.#stmt('putAsset').run(asset.id, asset.createdAt, JSON.stringify(asset))
  }

  patchAsset(id: string, patch: Partial<Asset>): Asset {
    return this.transaction(() => {
      const current = this.getAsset(id)
      if (!current) throw new Error(`asset not found: ${id}`)
      const next: Asset = { ...current, ...patch, id }
      this.putAsset(next)
      return next
    })
  }

  deleteAsset(id: string): void {
    this.#stmt('deleteAsset').run(id)
  }

  /* ------------------------------------------------------------ jobs */

  getJob(id: string): Job | undefined {
    return this.getJobRecord(id)?.job
  }

  getJobRecord(id: string): JobRecord | undefined {
    const row = this.#stmt('getJob').get(id) as Row | undefined
    return row ? this.#jobRecord(row) : undefined
  }

  #jobRecord(row: Row): JobRecord {
    return {
      job: JSON.parse(String(row.data)) as Job,
      payload: JSON.parse(String(row.payload)) as unknown,
      priority: Number(row.priority),
      attempts: Number(row.attempts),
      seq: Number(row.seq),
    }
  }

  listJobs(
    filter: { projectId?: string; assetId?: string; active?: boolean; limit?: number } = {},
  ): Job[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.projectId) {
      where.push('project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.assetId) {
      where.push('asset_id = ?')
      params.push(filter.assetId)
    }
    if (filter.active !== undefined) {
      const set = filter.active ? ACTIVE : FINISHED
      where.push(`status IN (${set.map(() => '?').join(',')})`)
      params.push(...set)
    }
    const limit = filter.limit ?? 500
    if (where.length === 0)
      return (this.#stmt('listJobsAll').all(limit) as Row[]).map(
        (r) => JSON.parse(String(r.data)) as Job,
      )
    // Dynamic filter combinations are few; SQLite caches the compiled statement per text.
    const rows = this.db
      .prepare(
        `SELECT data FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, seq DESC LIMIT ?`,
      )
      .all(...params, limit) as Row[]
    return rows.map((r) => JSON.parse(String(r.data)) as Job)
  }

  /** Inserts a new job with its payload and scheduling priority. */
  insertJob(job: Job, payload: unknown, priority: number): number {
    const seq = ++this.#seq
    this.#stmt('insertJob').run(
      job.id,
      seq,
      job.kind,
      job.status,
      priority,
      job.projectId ?? null,
      job.assetId ?? null,
      job.createdAt,
      job.finishedAt ?? null,
      JSON.stringify(payload ?? {}),
      JSON.stringify(job),
    )
    return seq
  }

  /** Updates a job document (status/progress/result). Inserts it if unknown. */
  putJob(job: Job): void {
    const res = this.#stmt('updateJob').run(
      job.status,
      job.finishedAt ?? null,
      job.projectId ?? null,
      job.assetId ?? null,
      JSON.stringify(job),
      job.id,
    )
    if (Number(res.changes) === 0) this.insertJob(job, {}, 50)
  }

  setJobAttempts(id: string, attempts: number): void {
    this.#stmt('setAttempts').run(attempts, id)
  }

  jobsWithStatus(status: JobStatus): JobRecord[] {
    return (this.#stmt('jobsByStatus').all(status) as Row[]).map((r) => this.#jobRecord(r))
  }

  /** Finished jobs whose `finishedAt` is before `iso`. */
  finishedJobsBefore(iso: string): Array<{ id: string; kind: string; finishedAt: string }> {
    return (this.#stmt('finishedBefore').all(iso) as Row[]).map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      finishedAt: String(r.finished_at),
    }))
  }

  deleteJob(id: string): void {
    this.#stmt('deleteJob').run(id)
  }

  /* ------------------------------------------------------------ settings */

  getSetting<T>(key: string): T | undefined {
    const row = this.#stmt('getSetting').get(key) as Row | undefined
    return row ? (JSON.parse(String(row.value)) as T) : undefined
  }

  setSetting<T>(key: string, value: T): void {
    if (value === undefined) this.#stmt('deleteSetting').run(key)
    else this.#stmt('setSetting').run(key, JSON.stringify(value))
  }

  /* ------------------------------------------------------------ devices */

  insertDevice(device: Omit<DeviceRecord, 'lastSeenAt'> & { tokenHash: Uint8Array }): DeviceRecord {
    this.#stmt('insertDevice').run(
      device.id,
      device.name,
      device.tokenHash,
      device.userAgent ?? null,
      device.createdAt,
      device.createdAt,
    )
    return {
      id: device.id,
      name: device.name,
      ...(device.userAgent ? { userAgent: device.userAgent } : {}),
      createdAt: device.createdAt,
      lastSeenAt: device.createdAt,
    }
  }

  #device(r: Row): DeviceRecord {
    const ua = str(r.user_agent)
    return {
      id: String(r.id),
      name: String(r.name),
      ...(ua ? { userAgent: ua } : {}),
      createdAt: String(r.created_at),
      lastSeenAt: String(r.last_seen_at),
    }
  }

  deviceByTokenHash(hash: Uint8Array): DeviceRecord | undefined {
    const row = this.#stmt('deviceByHash').get(hash) as Row | undefined
    return row ? this.#device(row) : undefined
  }

  listDevices(): DeviceRecord[] {
    return (this.#stmt('listDevices').all() as Row[]).map((r) => this.#device(r))
  }

  deleteDevice(id: string): boolean {
    return Number(this.#stmt('deleteDevice').run(id).changes) > 0
  }

  touchDevice(id: string, at: string): void {
    this.#stmt('touchDevice').run(at, id)
  }

  /* ------------------------------------------------------------ uploads */

  insertUpload(u: Omit<UploadRecord, 'received' | 'updatedAt'>): UploadRecord {
    const received = new Uint8Array(Math.ceil(u.chunks / 8))
    this.#stmt('insertUpload').run(
      u.id,
      u.name,
      u.mime,
      u.size,
      u.chunkSize,
      u.chunks,
      received,
      u.deviceId ?? null,
      u.createdAt,
      u.createdAt,
    )
    return { ...u, received, updatedAt: u.createdAt }
  }

  #upload(r: Row): UploadRecord {
    const deviceId = str(r.device_id)
    return {
      id: String(r.id),
      name: String(r.name),
      mime: String(r.mime),
      size: Number(r.size),
      chunkSize: Number(r.chunk_size),
      chunks: Number(r.chunks),
      received: r.received as Uint8Array,
      ...(deviceId ? { deviceId } : {}),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  }

  getUpload(id: string): UploadRecord | undefined {
    const row = this.#stmt('getUpload').get(id) as Row | undefined
    return row ? this.#upload(row) : undefined
  }

  listUploads(): UploadRecord[] {
    return (this.#stmt('listUploads').all() as Row[]).map((r) => this.#upload(r))
  }

  /**
   * Marks chunk `index` as received. Atomic read-modify-write of the bitmap (node:sqlite is
   * synchronous, so concurrent chunk requests cannot interleave inside this call).
   */
  markChunk(id: string, index: number): { received: number; chunks: number } | undefined {
    return this.transaction(() => {
      const u = this.getUpload(id)
      if (!u) return undefined
      const bits = new Uint8Array(u.received)
      bits[index >> 3] = bits[index >> 3]! | (1 << (index & 7))
      this.#stmt('setReceived').run(bits, new Date().toISOString(), id)
      return { received: popcount(bits), chunks: u.chunks }
    })
  }

  deleteUpload(id: string): void {
    this.#stmt('deleteUpload').run(id)
  }
}
