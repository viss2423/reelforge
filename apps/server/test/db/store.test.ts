import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import type { Asset, Job, Project } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RevisionConflictError } from '../../src/contracts.ts'
import { MIGRATIONS, migrate } from '../../src/db/migrations.ts'
import { bitmapIndices, SqliteStore } from '../../src/db/store.ts'
import { tempDir } from '../helpers.ts'

const project = (id: string, over: Partial<Project> = {}): Project => ({
  schemaVersion: 1,
  id,
  name: `Project ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revision: 0,
  settings: { width: 1080, height: 1920, fps: 30, background: '#000000', backgroundBlur: false },
  tracks: [
    { id: 'main', kind: 'main', name: '', muted: false, hidden: false, locked: false, clips: [] },
  ],
  markers: [],
  ...over,
})

const asset = (id: string, createdAt = '2026-01-01T00:00:00.000Z'): Asset => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  size: 100,
  mime: 'video/mp4',
  createdAt,
  hasAudio: false,
  hasVideo: true,
  proxy: 'pending',
  thumbnails: 'pending',
  waveform: 'pending',
})

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  kind: 'probe',
  status: 'queued',
  progress: 0,
  createdAt: new Date().toISOString(),
  ...over,
})

describe('SqliteStore', () => {
  let dir: string
  let cleanup: () => Promise<void>
  let store: SqliteStore

  beforeEach(async () => {
    ;({ dir, cleanup } = await tempDir())
    store = new SqliteStore(path.join(dir, 'db.sqlite'))
  })
  afterEach(async () => {
    store.close()
    await cleanup()
  })

  it('uses WAL, NORMAL sync and foreign keys', () => {
    const pragma = (name: string): unknown =>
      Object.values(store.db.prepare(`PRAGMA ${name}`).get()!)[0]
    expect(pragma('journal_mode')).toBe('wal')
    expect(pragma('synchronous')).toBe(1)
    expect(pragma('foreign_keys')).toBe(1)
  })

  it('creates, updates and lists projects with optimistic revisions', () => {
    expect(store.saveProject(project('p1'), 0)).toBe(1)
    expect(store.getProject('p1')?.revision).toBe(1)
    expect(store.saveProject({ ...project('p1'), name: 'Renamed' }, 1)).toBe(2)
    const saved = store.getProject('p1')!
    expect(saved.name).toBe('Renamed')
    expect(saved.revision).toBe(2)
    expect(store.getProject('missing')).toBeUndefined()
  })

  it('rejects stale saves with RevisionConflictError carrying the current revision', () => {
    store.saveProject(project('p1'), 0)
    store.saveProject(project('p1'), 1)
    let error: unknown
    try {
      store.saveProject(project('p1'), 1)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(RevisionConflictError)
    expect((error as RevisionConflictError).current).toBe(2)
    // a "create" against an existing project is also a conflict
    expect(() => store.saveProject(project('p1'), 0)).toThrow(RevisionConflictError)
    // and saving a missing project with a non-zero revision
    expect(() => store.saveProject(project('p2'), 3)).toThrow(RevisionConflictError)
    expect(store.getProject('p1')?.revision).toBe(2)
  })

  it('summarises projects (duration, thumbnail, newest first)', () => {
    const clip = {
      id: 'c1',
      type: 'video' as const,
      assetId: 'a1',
      start: 0,
      duration: 5_000_000,
    }
    store.saveProject(project('old', { updatedAt: '2026-01-01T00:00:00.000Z' }), 0)
    const withClip = project('new', {
      updatedAt: '2026-02-01T00:00:00.000Z',
      tracks: [
        {
          id: 'main',
          kind: 'main',
          name: '',
          muted: false,
          hidden: false,
          locked: false,
          clips: [clip as unknown as Project['tracks'][number]['clips'][number]],
        },
      ],
    })
    store.saveProject(withClip, 0)
    const list = store.listProjects()
    expect(list.map((p) => p.id)).toEqual(['new', 'old'])
    expect(list[0]).toMatchObject({ duration: 5_000_000, thumbAssetId: 'a1' })
    expect(list[1]).not.toHaveProperty('thumbAssetId')
    store.deleteProject('new')
    expect(store.listProjects().map((p) => p.id)).toEqual(['old'])
  })

  it('stores, patches and deletes assets', () => {
    store.putAsset(asset('a1', '2026-01-01T00:00:00.000Z'))
    store.putAsset(asset('a2', '2026-01-02T00:00:00.000Z'))
    expect(store.listAssets().map((a) => a.id)).toEqual(['a2', 'a1'])
    const patched = store.patchAsset('a1', { proxy: 'ready', width: 540 })
    expect(patched).toMatchObject({ id: 'a1', proxy: 'ready', width: 540 })
    expect(store.getAsset('a1')).toEqual(patched)
    expect(() => store.patchAsset('nope', {})).toThrow(/not found/)
    store.deleteAsset('a1')
    expect(store.getAsset('a1')).toBeUndefined()
  })

  it('persists jobs with priority/sequence and filters lists', () => {
    store.insertJob(job('j1', { assetId: 'a1' }), { assetId: 'a1' }, 10)
    store.insertJob(job('j2', { projectId: 'p1', kind: 'export' }), { projectId: 'p1' }, 5)
    store.putJob({
      ...job('j1', { assetId: 'a1' }),
      status: 'done',
      finishedAt: new Date().toISOString(),
    })
    expect(store.getJob('j1')?.status).toBe('done')
    expect(store.getJobRecord('j2')).toMatchObject({
      priority: 5,
      payload: { projectId: 'p1' },
      attempts: 0,
    })
    expect(store.listJobs({ active: true }).map((j) => j.id)).toEqual(['j2'])
    expect(store.listJobs({ active: false }).map((j) => j.id)).toEqual(['j1'])
    expect(store.listJobs({ assetId: 'a1' }).map((j) => j.id)).toEqual(['j1'])
    expect(store.listJobs({ projectId: 'p1', active: true }).map((j) => j.id)).toEqual(['j2'])
    expect(store.listJobs().length).toBe(2)
    store.setJobAttempts('j2', 2)
    expect(store.jobsWithStatus('queued')[0]).toMatchObject({ attempts: 2 })
    // putJob of an unknown job inserts it
    store.putJob(job('j3'))
    expect(store.getJob('j3')).toBeDefined()
    // sequence survives a reopen (FIFO across restarts)
    const seq = store.getJobRecord('j3')!.seq
    store.close()
    store = new SqliteStore(path.join(dir, 'db.sqlite'))
    expect(store.insertJob(job('j4'), {}, 1)).toBe(seq + 1)
  })

  it('round-trips settings (and deletes with undefined)', () => {
    store.setSetting('a', { x: 1 })
    expect(store.getSetting('a')).toEqual({ x: 1 })
    store.setSetting('a', undefined)
    expect(store.getSetting('a')).toBeUndefined()
  })

  it('manages devices by token hash', () => {
    const hash = new Uint8Array(32).fill(7)
    store.insertDevice({
      id: 'd1',
      name: 'Phone',
      tokenHash: hash,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(store.deviceByTokenHash(hash)?.name).toBe('Phone')
    expect(store.deviceByTokenHash(new Uint8Array(32))).toBeUndefined()
    store.touchDevice('d1', '2026-03-01T00:00:00.000Z')
    expect(store.listDevices()[0]?.lastSeenAt).toBe('2026-03-01T00:00:00.000Z')
    expect(store.deleteDevice('d1')).toBe(true)
    expect(store.deleteDevice('d1')).toBe(false)
  })

  it('tracks upload chunks in a bitmap', () => {
    store.insertUpload({
      id: 'u1',
      name: 'a.mp4',
      mime: 'video/mp4',
      size: 100,
      chunkSize: 10,
      chunks: 10,
      createdAt: new Date().toISOString(),
    })
    expect(store.markChunk('u1', 9)).toEqual({ received: 1, chunks: 10 })
    expect(store.markChunk('u1', 0)).toEqual({ received: 2, chunks: 10 })
    expect(store.markChunk('u1', 0)).toEqual({ received: 2, chunks: 10 })
    expect(bitmapIndices(store.getUpload('u1')!.received, 10)).toEqual([0, 9])
    expect(store.markChunk('missing', 0)).toBeUndefined()
    store.deleteUpload('u1')
    expect(store.getUpload('u1')).toBeUndefined()
  })

  it('rolls back failed transactions', () => {
    store.putAsset(asset('a1'))
    expect(() =>
      store.transaction(() => {
        store.deleteAsset('a1')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(store.getAsset('a1')).toBeDefined()
  })
})

describe('migrations', () => {
  it('apply once, are recorded, and roll back atomically on failure', async () => {
    const { dir, cleanup } = await tempDir()
    const db = new DatabaseSync(path.join(dir, 'm.sqlite'))
    try {
      expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version))
      expect(migrate(db)).toEqual([])
      const extra = [
        ...MIGRATIONS,
        {
          version: 99,
          name: 'bad',
          sql: 'CREATE TABLE t (x INTEGER); SELECT * FROM missing_table;',
        },
      ]
      expect(() => migrate(db, extra)).toThrow(/migration 99 \(bad\) failed/)
      // the failed migration left nothing behind
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeUndefined()
      expect(db.prepare('SELECT version FROM migrations WHERE version = 99').get()).toBeUndefined()
      const good = [...MIGRATIONS, { version: 2, name: 'add', sql: 'CREATE TABLE t2 (x INTEGER)' }]
      expect(migrate(db, good)).toEqual([2])
    } finally {
      db.close()
      await cleanup()
    }
  })
})
