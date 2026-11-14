import { existsSync } from 'node:fs'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Job, JobKind } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DataPaths } from '../../src/contracts.ts'
import { SqliteStore } from '../../src/db/store.ts'
import { runMaintenance } from '../../src/jobs/maintenance.ts'
import { exportFile } from '../../src/paths.ts'
import { uploadTempFile } from '../../src/media/uploads.ts'
import { log, tempData } from '../helpers.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

describe('runMaintenance', () => {
  let paths: DataPaths
  let store: SqliteStore
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ paths, cleanup } = await tempData())
    store = new SqliteStore(paths.db)
  })
  afterEach(async () => {
    store.close()
    await cleanup()
  })

  const job = (id: string, kind: JobKind, status: Job['status'], finishedAgo?: number): void => {
    store.insertJob(
      {
        id,
        kind,
        status,
        progress: status === 'done' ? 1 : 0,
        createdAt: iso((finishedAgo ?? 0) + HOUR),
        ...(finishedAgo === undefined ? {} : { finishedAt: iso(finishedAgo) }),
      },
      {},
      50,
    )
  }

  const touch = async (file: string, msAgo: number): Promise<void> => {
    const t = new Date(NOW - msAgo)
    await utimes(file, t, t)
  }

  const run = () =>
    runMaintenance({
      store,
      paths,
      log,
      jobRetentionMs: 7 * DAY,
      exportRetentionMs: 30 * DAY,
      isActiveJob: (id) => id === 'active-job',
      now: NOW,
    })

  it('prunes finished jobs past retention; exports keep longer and take their MP4 with them', async () => {
    job('old-probe', 'probe', 'done', 8 * DAY)
    job('recent-probe', 'probe', 'failed', 2 * DAY)
    job('old-export', 'export', 'done', 31 * DAY)
    job('mid-export', 'export', 'done', 8 * DAY)
    job('running', 'proxy', 'running')
    await writeFile(exportFile(paths, 'old-export'), 'mp4')
    await writeFile(exportFile(paths, 'mid-export'), 'mp4')

    const report = await run()
    expect(report).toMatchObject({ jobs: 2, exports: 1 })
    expect(store.getJob('old-probe')).toBeUndefined()
    expect(store.getJob('old-export')).toBeUndefined()
    for (const id of ['recent-probe', 'mid-export', 'running'])
      expect(store.getJob(id)).toBeDefined()
    expect(existsSync(exportFile(paths, 'old-export'))).toBe(false)
    expect(existsSync(exportFile(paths, 'mid-export'))).toBe(true)
  })

  it('removes abandoned uploads and their temp files, keeping live ones', async () => {
    await mkdir(path.join(paths.tmp, 'uploads'), { recursive: true })
    const base = { name: 'a.mp4', mime: 'video/mp4', size: 10, chunkSize: 10, chunks: 1 }
    store.insertUpload({ ...base, id: 'stale', createdAt: iso(3 * DAY) })
    store.insertUpload({ ...base, id: 'live', createdAt: iso(HOUR) })
    for (const id of ['stale', 'live']) await writeFile(uploadTempFile(paths, id), 'x')
    // A live upload's temp file is kept even when its mtime is old (preallocated, sparse writes).
    await touch(uploadTempFile(paths, 'live'), 3 * DAY)
    // An orphaned part file with no upload row.
    const orphan = path.join(paths.tmp, 'uploads', 'ghost.part')
    await writeFile(orphan, 'x')
    await touch(orphan, 2 * DAY)

    const report = await run()
    expect(report.uploads).toBe(1)
    expect(store.getUpload('stale')).toBeUndefined()
    expect(store.getUpload('live')).toBeDefined()
    expect(existsSync(uploadTempFile(paths, 'stale'))).toBe(false)
    expect(existsSync(uploadTempFile(paths, 'live'))).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it('sweeps stale temp entries but never active jobs or fresh files', async () => {
    const stale = path.join(paths.tmp, 'crashed-job')
    const active = path.join(paths.tmp, 'active-job')
    const fresh = path.join(paths.tmp, 'fresh.txt')
    await mkdir(stale)
    await writeFile(path.join(stale, 'graph.txt'), 'x')
    await mkdir(active)
    await writeFile(fresh, 'x')
    await touch(stale, 2 * DAY)
    await touch(active, 2 * DAY)
    await touch(fresh, HOUR)

    const report = await run()
    expect(report.tmp).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(active)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
  })

  it('validates export job ids', () => {
    expect(() => exportFile(paths, '../evil')).toThrow(/invalid job id/)
  })
})
