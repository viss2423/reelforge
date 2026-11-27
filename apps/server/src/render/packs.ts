/**
 * Pack lookups for a render: resolves the `<packId>/<itemId>` refs a project uses (LUT
 * filters, stickers, effects, animations) against `<packs>/<packId>/pack.json`.
 *
 * Only the packs the project actually references are read and validated, once per render,
 * so the compiler's synchronous resolvers never touch the disk.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PackManifest,
  resolveBuiltinAnimation,
  type AnimationPreset,
  type EffectPreset,
  type Project,
} from '@reelforge/core'
import type { Logger } from '../contracts.ts'

const SAFE_ID = /^[A-Za-z0-9_.-]{1,64}$/
/** A single safe path segment (never `.` / `..`). */
const isSafeId = (id: string): boolean => SAFE_ID.test(id) && !/^\.+$/.test(id)
const BUILTIN = 'builtin'

/** The repository's bundled packs (dev / offline fallback). */
export const BUNDLED_PACKS = fileURLToPath(new URL('../../../../packs', import.meta.url))

/**
 * The pack tree to read: `paths.packs` (the server passes the active synced tree there), an
 * `active.json` pointer inside it if present, or the bundled packs when nothing is synced.
 */
export async function resolvePacksRoot(packs: string): Promise<string> {
  try {
    const pointer = JSON.parse(await readFile(path.join(packs, 'active.json'), 'utf8')) as {
      dir?: unknown
    }
    if (typeof pointer.dir === 'string' && isSafeId(pointer.dir)) {
      const dir = path.join(packs, pointer.dir)
      if (existsSync(dir)) return dir
    }
  } catch {
    // No pointer: `packs` is the tree itself.
  }
  if (
    existsSync(packs) &&
    (existsSync(path.join(packs, 'index.json')) || existsSync(path.join(packs, 'fonts')))
  ) {
    return packs
  }
  return existsSync(BUNDLED_PACKS) ? BUNDLED_PACKS : packs
}

/** Split `<packId>/<itemId>`; undefined when malformed or unsafe. */
export function parseRef(ref: string): { packId: string; itemId: string } | undefined {
  const slash = ref.indexOf('/')
  if (slash <= 0) return undefined
  const packId = ref.slice(0, slash)
  const itemId = ref.slice(slash + 1)
  if (!isSafeId(packId) || itemId.length === 0) return undefined
  return { packId, itemId }
}

/** Every pack ref a project uses. */
export function projectRefs(p: Project): Set<string> {
  const refs = new Set<string>()
  const addRef = (r: string | undefined): void => {
    if (r) refs.add(r)
  }
  for (const track of p.tracks) {
    for (const c of track.clips) {
      switch (c.type) {
        case 'video':
        case 'image':
          addRef(c.filter?.ref)
          for (const e of c.effects) addRef(e.ref)
          break
        case 'sticker':
          addRef(c.ref)
          addRef(c.animationIn?.ref)
          addRef(c.animationOut?.ref)
          break
        case 'text':
          addRef(c.animationIn?.ref)
          addRef(c.animationOut?.ref)
          addRef(c.animationLoop?.ref)
          break
        case 'audio':
          break
      }
    }
  }
  return refs
}

/** A file inside `dir`, or undefined when `rel` escapes it. */
function inside(dir: string, rel: string): string | undefined {
  const full = path.resolve(dir, rel)
  const base = path.resolve(dir) + path.sep
  return full.startsWith(base) ? full : undefined
}

/** Synchronous resolvers handed to the compiler and the ASS builder. */
export interface PackResolvers {
  /** Root of the pack tree in use. */
  root: string
  resolveLut(ref: string): string | undefined
  resolveSticker(ref: string): string | undefined
  resolveEffect(ref: string): EffectPreset | undefined
  resolveAnimation(ref: string): AnimationPreset | undefined
}

/** Load the manifests referenced by `refs` and build the resolvers. */
export async function loadPackResolvers(
  packsDir: string,
  refs: Iterable<string>,
  log?: Logger,
  /** Further trees searched for packs missing from `packsDir` (locally generated packs). */
  extraRoots: readonly string[] = [],
): Promise<PackResolvers> {
  const root = await resolvePacksRoot(packsDir)
  const dirs = new Map<string, string>()
  const packIds = new Set<string>()
  for (const r of refs) {
    const parsed = parseRef(r)
    if (parsed && parsed.packId !== BUILTIN) packIds.add(parsed.packId)
  }
  const manifests = new Map<string, PackManifest>()
  await Promise.all(
    [...packIds].map(async (id) => {
      let lastErr: unknown
      for (const base of [root, ...extraRoots]) {
        try {
          const raw = await readFile(path.join(base, id, 'pack.json'), 'utf8')
          manifests.set(id, PackManifest.parse(JSON.parse(raw)))
          dirs.set(id, path.join(base, id))
          return
        } catch (err) {
          lastErr = err
        }
      }
      log?.warn({ pack: id, err: lastErr }, 'pack unavailable; its refs are ignored')
    }),
  )
  const lookup = (ref: string): { m: PackManifest; itemId: string; dir: string } | undefined => {
    const parsed = parseRef(ref)
    const m = parsed && manifests.get(parsed.packId)
    return m && parsed
      ? { m, itemId: parsed.itemId, dir: dirs.get(parsed.packId) ?? path.join(root, parsed.packId) }
      : undefined
  }
  return {
    root,
    resolveLut(ref) {
      const l = lookup(ref)
      const f = l?.m.filters.find((x) => x.id === l.itemId)
      return l && f ? inside(l.dir, f.lut) : undefined
    },
    resolveSticker(ref) {
      const l = lookup(ref)
      const s = l?.m.stickers.find((x) => x.id === l.itemId)
      return l && s ? inside(l.dir, s.file) : undefined
    },
    resolveEffect(ref) {
      const l = lookup(ref)
      return l?.m.effects.find((x) => x.id === l.itemId)
    },
    resolveAnimation(ref) {
      if (ref.startsWith(`${BUILTIN}/`)) return resolveBuiltinAnimation(ref)
      const l = lookup(ref)
      return l?.m.animations.find((x) => x.id === l.itemId)
    },
  }
}
