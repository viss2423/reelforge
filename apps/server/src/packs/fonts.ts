/**
 * Flat font directory for libass.
 *
 * FFmpeg's `ass`/`subtitles` filters take ONE `fontsdir` and libass does not scan it
 * recursively, but packs ship fonts as `<packs>/fonts/<Family>/*.ttf`. `flatFontsDir` gives
 * the render module a flat view of the active pack tree's fonts under
 * `<data>/fonts-flat/<key>/`, built from hard links (a copy when linking is not possible,
 * e.g. across volumes) so it costs no extra disk space in the common case.
 *
 * - Each pack tree gets its own directory (`key` = hash of the source path). Synced trees are
 *   immutable once active, so a finished directory never needs rebuilding — a sync simply
 *   produces a new tree and therefore a new key.
 * - The directory is built in a temp sibling and renamed into place, with a `.source` marker
 *   written last, so a crash never leaves a half-populated directory that looks complete.
 * - Concurrent callers in this process share one build; finished directories are reused
 *   across restarts.
 * - Directories whose source tree no longer exists (garbage-collected syncs) are removed
 *   best-effort; on Windows a directory still open in an encode fails to delete and is
 *   retried on a later call.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  access,
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { DataPaths } from '../contracts.ts'

const FONT_FILE = /\.(?:ttf|otf|ttc)$/i
const MARKER = '.source'

const builds = new Map<string, Promise<string>>()

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  )

/** Code-unit order: deterministic regardless of locale. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Font files under `<source>/<Family>/`, with collision-free flat names. */
const listFonts = async (source: string): Promise<Array<{ from: string; name: string }>> => {
  let families: string[]
  try {
    families = (await readdir(source, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .toSorted(byName)
  } catch {
    return [] // no fonts in this pack tree: libass falls back to system fonts
  }
  const lists = await Promise.all(
    families.map(async (family) =>
      (await readdir(path.join(source, family), { withFileTypes: true }))
        .filter((e) => e.isFile() && FONT_FILE.test(e.name))
        .map((e) => ({ family, file: e.name }))
        .toSorted((a, b) => byName(a.file, b.file)),
    ),
  )
  const taken = new Set<string>()
  return lists.flat().map(({ family, file }) => {
    // libass matches by the family name inside the font, so the file name only has to be unique.
    const name = taken.has(file.toLowerCase()) ? `${family}__${file}` : file
    taken.add(name.toLowerCase())
    return { from: path.join(source, family, file), name }
  })
}

const linkOrCopy = async (from: string, to: string): Promise<void> => {
  try {
    await link(from, to)
  } catch {
    await copyFile(from, to)
  }
}

/** Removes flat directories whose pack tree is gone (best-effort). */
const collect = async (base: string, keep: string): Promise<void> => {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && e.name !== keep)
      .map(async (e) => {
        const dir = path.join(base, e.name)
        const source = await readFile(path.join(dir, MARKER), 'utf8').catch(() => undefined)
        // No marker: a build in progress (possibly another process) — leave it alone.
        if (source === undefined || (await exists(source))) return
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }),
  )
}

const build = async (source: string, base: string, key: string): Promise<string> => {
  const dir = path.join(base, key)
  if (await exists(path.join(dir, MARKER))) return dir
  await mkdir(base, { recursive: true })
  const tmp = `${dir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await rm(dir, { recursive: true, force: true }) // a crashed build without its marker
  await mkdir(tmp)
  try {
    const fonts = await listFonts(source)
    await Promise.all(fonts.map((f) => linkOrCopy(f.from, path.join(tmp, f.name))))
    await writeFile(path.join(tmp, MARKER), source)
    await rename(tmp, dir)
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    // Another process may have won the rename race with an identical directory.
    if (await exists(path.join(dir, MARKER))) return dir
    throw err
  }
  await collect(base, key)
  return dir
}

/**
 * Absolute path of a flat directory containing every font of the pack tree at `paths.packs`
 * (for FFmpeg's `fontsdir=`). Cheap after the first call for a given tree.
 */
export const flatFontsDir = (paths: Pick<DataPaths, 'root' | 'packs'>): Promise<string> => {
  const source = path.resolve(paths.packs, 'fonts')
  const base = path.join(paths.root, 'fonts-flat')
  const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const id = path.join(base, key)
  let pending = builds.get(id)
  if (!pending) {
    pending = build(source, base, key)
    builds.set(id, pending)
    // A failed build is retried on the next call instead of caching the error.
    pending.catch(() => builds.delete(id))
  }
  return pending
}
