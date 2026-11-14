/**
 * Periodic housekeeping so an always-on host never accumulates garbage:
 * - finished jobs older than the retention window (exports keep longer, and their MP4 goes too),
 * - abandoned uploads (no chunk for `uploadTtlMs`) and their preallocated temp files,
 * - orphaned temp files/directories (crashed encodes, partial downloads).
 */
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DataPaths, Logger } from '../contracts.ts'
import type { SqliteStore } from '../db/store.ts'
import { uploadTempFile } from '../media/uploads.ts'
import { exportFile } from '../paths.ts'

export interface MaintenanceOptions {
  store: SqliteStore
  paths: DataPaths
  log: Logger
  jobRetentionMs: number
  exportRetentionMs: number
  uploadTtlMs?: number
  tmpTtlMs?: number
  /** Jobs that are currently active must keep their temp files. */
  isActiveJob?: (id: string) => boolean
  now?: number
}

export interface MaintenanceReport {
  jobs: number
  exports: number
  uploads: number
  tmp: number
}

const HOUR = 3_600_000

export const runMaintenance = async (opts: MaintenanceOptions): Promise<MaintenanceReport> => {
  const now = opts.now ?? Date.now()
  const { store, paths } = opts
  const report: MaintenanceReport = { jobs: 0, exports: 0, uploads: 0, tmp: 0 }

  const cutoff = new Date(now - Math.min(opts.jobRetentionMs, opts.exportRetentionMs)).toISOString()
  const jobCutoff = new Date(now - opts.jobRetentionMs).toISOString()
  const exportCutoff = new Date(now - opts.exportRetentionMs).toISOString()
  for (const job of store.finishedJobsBefore(cutoff)) {
    const isExport = job.kind === 'export'
    if (job.finishedAt >= (isExport ? exportCutoff : jobCutoff)) continue
    store.deleteJob(job.id)
    report.jobs++
    if (isExport) {
      await rm(exportFile(paths, job.id), { force: true })
      report.exports++
    }
  }

  const uploadTtl = opts.uploadTtlMs ?? 48 * HOUR
  const live = new Set<string>()
  for (const u of store.listUploads()) {
    if (Date.parse(u.updatedAt) < now - uploadTtl) {
      store.deleteUpload(u.id)
      await rm(uploadTempFile(paths, u.id), { force: true })
      report.uploads++
    } else live.add(path.basename(uploadTempFile(paths, u.id)))
  }

  const tmpTtl = opts.tmpTtlMs ?? 24 * HOUR
  const sweep = async (dir: string, keep: (name: string) => boolean): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (name) => {
        if (keep(name)) return
        const full = path.join(dir, name)
        try {
          const s = await stat(full)
          if (s.mtimeMs >= now - tmpTtl) return
          await rm(full, { recursive: true, force: true })
          report.tmp++
        } catch (err) {
          opts.log.debug({ err, file: full }, 'tmp sweep skipped entry')
        }
      }),
    )
  }
  await sweep(path.join(paths.tmp, 'uploads'), (name) => live.has(name))
  await sweep(paths.tmp, (name) => name === 'uploads' || (opts.isActiveJob?.(name) ?? false))
  return report
}
