/**
 * Locally generated packs (the trend engine's `trending-live`), kept beside — never inside —
 * the synced tree so a pack sync can't wipe them and a hash-verified tree is never mutated.
 *
 * Layout under `<data>/packs/local`:
 *   active.json            → { dir, version } — swapped atomically with a rename
 *   <dir>/<packId>/…       → pack.json + thumbs/LUTs, like any pack folder
 *
 * A writer stages a complete new `<dir>`, then flips the pointer; readers that still hold
 * files of the old dir keep working until it is garbage-collected by a later write (on
 * Windows, directories with open files cannot be removed — same pattern as `service.ts`).
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PackManifest } from '@reelforge/core'
import type { Logger } from '../contracts.ts'
import { isSafePackId } from './files.ts'

export interface LocalPointer {
  dir: string
  version: string
}

/** `<data>/packs/local` for a data root. */
export const localPacksRoot = (dataRoot: string): string => path.join(dataRoot, 'packs', 'local')

/** The active local tree directory, or undefined when nothing was generated yet. */
export const activeLocalDir = async (root: string): Promise<string | undefined> => {
  try {
    const p = JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8')) as LocalPointer
    if (typeof p.dir !== 'string' || !isSafePackId(p.dir)) return undefined
    const dir = path.join(root, p.dir)
    return existsSync(dir) ? dir : undefined
  } catch {
    return undefined
  }
}

/** Reads and validates `<dir>/<packId>/pack.json`; undefined when absent or invalid. */
export const readLocalPack = async (
  dir: string,
  packId: string,
  log?: Logger,
): Promise<PackManifest | undefined> => {
  if (!isSafePackId(packId)) return undefined
  try {
    const raw = await readFile(path.join(dir, packId, 'pack.json'), 'utf8')
    const m = PackManifest.parse(JSON.parse(raw))
    return m.id === packId ? m : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      log?.warn({ err, pack: packId }, 'invalid local pack ignored')
    return undefined
  }
}

/**
 * Publishes a staged tree: `staging` (created by the caller inside `root` with
 * `stagingDir()`) becomes the active local tree. Older trees are removed best-effort.
 */
export const activateLocalTree = async (
  root: string,
  staging: string,
  version: string,
  log?: Logger,
): Promise<string> => {
  const dirName = `v-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const finalDir = path.join(root, dirName)
  await rename(staging, finalDir)
  const file = path.join(root, 'active.json')
  const pointer: LocalPointer = { dir: dirName, version }
  await writeFile(`${file}.tmp`, JSON.stringify(pointer))
  await rename(`${file}.tmp`, file)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === dirName) continue
    if (!entry.name.startsWith('v-') && !entry.name.startsWith('.staging-')) continue
    await rm(path.join(root, entry.name), { recursive: true, force: true }).catch((err: unknown) =>
      log?.debug({ err, dir: entry.name }, 'old local pack tree still in use'),
    )
  }
  return finalDir
}

/** A fresh staging directory inside `root`. */
export const stagingDir = async (root: string): Promise<string> => {
  await mkdir(root, { recursive: true })
  const dir = path.join(root, `.staging-${Date.now().toString(36)}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}
