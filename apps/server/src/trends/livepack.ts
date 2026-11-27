/**
 * Assembles, validates and atomically publishes the `trending-live` pack.
 *
 * 1. Merge: today's generated items + still-fresh items from previous runs (≤ carryDays).
 * 2. De-duplicate against every base pack (same name or same look/timing) and within itself.
 * 3. Localise refs: trend packs may only depend on themselves and `essentials`, so any item a
 *    generated item borrows from the monthly trend pack (an animation, effect, look, hook
 *    preset) is copied in — LUT files included — and the ref rewritten.
 * 4. Validate with the core zod schemas, the same semantic validator as build-packs
 *    (scripts/lib-packs/validate.mjs: refs, fonts, animations, transition timing) and extra
 *    duration checks; items that fail are dropped (with a reason) and validation re-runs.
 * 5. Render thumbnails with the build tool's FFmpeg/libass code, hash every file, write
 *    pack.json, then flip the local pointer (packs/local.ts) — readers never see a half pack.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PackManifest,
  type CaptionStylePreset,
  type FilterPreset,
  type PackIndex,
  type TemplatePreset,
  type TextPreset,
} from '@reelforge/core'
import { generateThumbs, listFontFiles, thumbPath } from '../../../../scripts/lib-packs/thumbs.mjs'
import { THUMB_KINDS, validatePacks } from '../../../../scripts/lib-packs/validate.mjs'
import type { Logger } from '../contracts.ts'
import { activateLocalTree, stagingDir } from '../packs/local.ts'
import { BASE_PACK, LIVE_PACK, uniqueId } from './catalogue.ts'
import { normalize } from './extract.ts'

export type LiveCollection = 'captionStyles' | 'textPresets' | 'templates'
const GENERATED: readonly LiveCollection[] = ['captionStyles', 'textPresets', 'templates']
type AnyItem = PackManifest[keyof Pick<
  PackManifest,
  | 'captionStyles'
  | 'textPresets'
  | 'filters'
  | 'animations'
  | 'transitions'
  | 'effects'
  | 'stickers'
  | 'templates'
>][number]

export interface NewItems {
  captionStyles: CaptionStylePreset[]
  textPresets: TextPreset[]
  templates: TemplatePreset[]
}

export interface BuildLivePackOptions {
  /** `<data>/packs/local` */
  root: string
  /** Served base packs (synced or bundled) and their directory. */
  base: {
    manifests: readonly PackManifest[]
    index: PackIndex | undefined
    dir: string | undefined
  }
  previous?: PackManifest | undefined
  /** Directory of the previous live pack (LUTs of carried copies are re-used from it). */
  previousDir?: string | undefined
  /** `<packId>/<itemId>` → ISO creation time of every generated item (carried + new). */
  createdAt: ReadonlyMap<string, string>
  fresh: NewItems
  now: Date
  carryDays?: number
  /** Max items per collection. */
  cap?: number
  ffmpeg: string
  /** Parallel thumbnail encodes (background work: keep it low). */
  concurrency?: number
  log?: Logger
  signal?: AbortSignal
  /** Skip FFmpeg (unit tests): items get no thumbnails and validation tolerates that. */
  skipThumbs?: boolean
}

export interface BuildLivePackResult {
  manifest: PackManifest
  dir: string
  /** Rejected items with the reason (validation / duplicate). */
  dropped: Array<{ ref: string; reason: string }>
  /** Refs created by this run (for the "New today" badge). */
  added: string[]
  ms: { validate: number; thumbs: number; total: number }
}

const DAY = 86_400_000

const fingerprint = (collection: string, item: AnyItem): string => {
  if (collection === 'templates') {
    const t = item as TemplatePreset
    return JSON.stringify(
      t.slots.map((s) => [s.duration, s.transitionIn?.type, s.filter, s.effects]),
    )
  }
  if (collection === 'textPresets') {
    const t = item as TextPreset
    return JSON.stringify([t.style, t.sampleText.toLowerCase()])
  }
  if (collection === 'captionStyles') return JSON.stringify((item as CaptionStylePreset).style)
  return item.id
}

/** Extra sanity rules beyond validate.mjs (generated content only). */
export const sanityErrors = (m: PackManifest): string[] => {
  const errs: string[] = []
  for (const t of m.templates) {
    const at = `${m.id}/templates/${t.id}`
    const total = t.slots.reduce((n, s) => n + s.duration, 0)
    if (total < 3_000_000 || total > 90_000_000)
      errs.push(`${at}: total ${total}us outside 3..90 s`)
    if (t.slots.length > 24) errs.push(`${at}: too many slots`)
    t.slots.forEach((s, i) => {
      if (s.duration < 200_000) errs.push(`${at}/slots[${i}]: slot shorter than 200 ms`)
      if (s.text && s.text.text.length > 80) errs.push(`${at}/slots[${i}]: text too long`)
    })
    if (t.musicHint?.bpm !== undefined && (t.musicHint.bpm < 50 || t.musicHint.bpm > 220))
      errs.push(`${at}: musicHint bpm out of range`)
  }
  for (const tp of m.textPresets)
    if (tp.sampleText.length > 80) errs.push(`${m.id}/textPresets/${tp.id}: sample text too long`)
  return errs
}

/** `trending-live/<collection>/<id>…: msg` → collection + id, when item-level. */
const itemOf = (err: string): { collection: string; id: string } | undefined => {
  const m = /^trending-live\/(\w+)\/([a-z0-9-]+)/.exec(err)
  return m ? { collection: m[1]!, id: m[2]! } : undefined
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

const walk = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .filter((f) => f !== 'pack.json')
    .toSorted()

export const liveVersion = (d: Date): string =>
  `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`

export const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const buildLivePack = async (o: BuildLivePackOptions): Promise<BuildLivePackResult> => {
  const t0 = performance.now()
  const carryMs = (o.carryDays ?? 14) * DAY
  const cap = o.cap ?? 24
  const dropped: BuildLivePackResult['dropped'] = []
  const baseManifests = o.base.manifests.filter((m) => m.id !== LIVE_PACK)
  const essentials = baseManifests.find((m) => m.id === BASE_PACK)

  // 1. merge: fresh first (tagged "new"), then carried items still within the window.
  const live: PackManifest = PackManifest.parse({
    id: LIVE_PACK,
    version: liveVersion(o.now),
    name: 'Trending today',
    description: 'Generated on this computer from today’s trends. Refreshed daily.',
    author: 'ReelForge trend engine',
    curatedAt: isoDay(o.now),
  })
  const taken = new Set<string>()
  const seenName = new Map<string, Set<string>>()
  const seenPrint = new Map<string, Set<string>>()
  for (const m of baseManifests)
    for (const c of GENERATED) {
      for (const item of m[c] as AnyItem[]) {
        const n = seenName.get(c) ?? new Set()
        n.add(normalize(item.name))
        seenName.set(c, n)
        const p = seenPrint.get(c) ?? new Set()
        p.add(fingerprint(c, item))
        seenPrint.set(c, p)
      }
    }
  const accept = (c: LiveCollection, item: AnyItem, isNew: boolean): boolean => {
    const ref = `${LIVE_PACK}/${item.id}`
    const name = normalize(item.name)
    const print = fingerprint(c, item)
    if (taken.has(item.id)) {
      dropped.push({ ref, reason: 'duplicate id' })
      return false
    }
    if (seenName.get(c)?.has(name)) {
      dropped.push({ ref, reason: 'duplicate name' })
      return false
    }
    if (seenPrint.get(c)?.has(print)) {
      dropped.push({ ref, reason: 'duplicate of an existing item' })
      return false
    }
    taken.add(item.id)
    seenName.get(c)?.add(name)
    seenPrint.get(c)?.add(print)
    const tags = item.tags.filter((t) => t !== 'new')
    // Deep copy: localisation below rewrites refs in place.
    ;(live[c] as AnyItem[]).push({
      ...structuredClone(item),
      tags: isNew ? ['new', ...tags] : tags,
    })
    return true
  }
  const added: string[] = []
  for (const c of GENERATED)
    for (const item of o.fresh[c] as AnyItem[])
      if ((live[c] as AnyItem[]).length < cap && accept(c, item, true))
        added.push(`${LIVE_PACK}/${item.id}`)
  for (const c of GENERATED)
    for (const item of (o.previous?.[c] ?? []) as AnyItem[]) {
      const created = o.createdAt.get(`${LIVE_PACK}/${item.id}`)
      if (!created || o.now.getTime() - Date.parse(created) > carryMs) continue
      if ((live[c] as AnyItem[]).length < cap) accept(c, item, false)
    }

  // 2. localise refs that point into other trend packs.
  const lutCopies = new Map<string, string>() // live lut path → source file
  const copied = new Map<string, string>() // source ref → live ref
  const find = (
    ref: string,
  ): { m: PackManifest; c: keyof PackManifest; item: AnyItem } | undefined => {
    const [packId, id] = ref.split('/')
    const m = baseManifests.find((x) => x.id === packId)
    if (!m) return undefined
    for (const c of ['animations', 'effects', 'filters', 'textPresets', 'captionStyles'] as const) {
      const item = (m[c] as AnyItem[]).find((i) => i.id === id)
      if (item) return { m, c, item }
    }
    return undefined
  }
  const localize = (
    ref: string | undefined,
    collection: keyof PackManifest,
  ): string | undefined => {
    if (!ref) return undefined
    const [packId, itemId] = ref.split('/')
    if (packId === BASE_PACK || packId === 'builtin') return ref
    const done = copied.get(ref)
    if (done) return done
    if (packId === LIVE_PACK) {
      if ((live[collection] as AnyItem[]).some((i) => i.id === itemId)) return ref
      // A copy made by an earlier run: bring it along with the item that still uses it.
      const prev = (o.previous?.[collection] as AnyItem[] | undefined)?.find((i) => i.id === itemId)
      if (!prev || taken.has(prev.id)) return undefined
      taken.add(prev.id)
      copied.set(ref, ref)
      const item = structuredClone(prev)
      delete (item as { thumb?: string }).thumb
      if (collection === 'filters' && o.previousDir)
        lutCopies.set(
          (item as FilterPreset).lut,
          path.join(o.previousDir, ...(item as FilterPreset).lut.split('/')),
        )
      ;(live[collection] as AnyItem[]).push(item)
      if (collection === 'textPresets') localizeAnimations(item as TextPreset)
      return ref
    }
    const found = find(ref)
    if (!found || found.c !== collection) return undefined
    const id = uniqueId(found.item.id, taken)
    const out = `${LIVE_PACK}/${id}`
    copied.set(ref, out)
    let item: AnyItem = { ...found.item, id, tags: found.item.tags.filter((t) => t !== 'new') }
    delete (item as { thumb?: string }).thumb
    if (collection === 'filters') {
      const f = found.item as FilterPreset
      const lut = `luts/${id}.cube`
      if (o.base.dir) lutCopies.set(lut, path.join(o.base.dir, found.m.id, ...f.lut.split('/')))
      item = { ...(item as FilterPreset), lut }
    }
    if (collection === 'textPresets') {
      const tp = item as TextPreset
      const animationIn = localize(tp.animationIn, 'animations')
      const animationOut = localize(tp.animationOut, 'animations')
      const animationLoop = localize(tp.animationLoop, 'animations')
      item = { ...tp } as TextPreset
      delete (item as TextPreset).animationIn
      delete (item as TextPreset).animationOut
      delete (item as TextPreset).animationLoop
      Object.assign(item, {
        ...(animationIn ? { animationIn } : {}),
        ...(animationOut ? { animationOut } : {}),
        ...(animationLoop ? { animationLoop } : {}),
      })
    }
    ;(live[collection] as AnyItem[]).push(item)
    return out
  }
  function localizeAnimations(tp: TextPreset): void {
    for (const k of ['animationIn', 'animationOut', 'animationLoop'] as const) {
      const r = localize(tp[k], 'animations')
      if (r) tp[k] = r
      else delete tp[k]
    }
  }
  // Snapshot: localising text presets appends copies to the same array.
  for (const tp of live.textPresets.slice()) localizeAnimations(tp)
  for (const t of live.templates) {
    const cs = localize(t.captionStyle, 'captionStyles')
    if (cs) t.captionStyle = cs
    else delete t.captionStyle
    for (const s of t.slots) {
      const f = localize(s.filter, 'filters')
      if (f) s.filter = f
      else delete s.filter
      s.effects = s.effects.flatMap((e) => localize(e, 'effects') ?? [])
      if (s.text) {
        const p = localize(s.text.preset, 'textPresets')
        if (p) s.text.preset = p
        else delete s.text
      }
    }
  }

  // Thumb pointers up front (validated now, rendered once the item set is final).
  const setThumbs = (m: PackManifest): void => {
    for (const [c, kind] of Object.entries(THUMB_KINDS))
      for (const item of m[c as LiveCollection] as AnyItem[]) {
        if (o.skipThumbs) delete (item as { thumb?: string }).thumb
        else (item as { thumb?: string }).thumb = thumbPath(kind, item.id)
      }
  }

  // 3. validate; drop failing items until clean.
  const tv = performance.now()
  let manifest = live
  for (let pass = 0; ; pass++) {
    setThumbs(manifest)
    manifest = PackManifest.parse(manifest)
    const errors = [
      ...validatePacks({
        manifests: [...(essentials ? [essentials] : []), manifest],
        fonts: o.base.index?.fonts ?? [],
        fileExists: (packId, rel) =>
          packId !== LIVE_PACK || rel.startsWith('thumbs/') || lutCopies.has(rel),
      }).filter((e) => e.startsWith(`${LIVE_PACK}/`) && !(o.skipThumbs && e.includes('thumbnail'))),
      ...sanityErrors(manifest),
    ]
    if (errors.length === 0) break
    const bad = new Map<string, string>()
    for (const e of errors) {
      const it = itemOf(e)
      if (!it) throw new Error(`live pack invalid: ${e}`)
      if (!bad.has(`${it.collection}/${it.id}`)) bad.set(`${it.collection}/${it.id}`, e)
    }
    if (pass >= 6) throw new Error(`live pack still invalid: ${errors[0]}`)
    for (const [key, reason] of bad) {
      const [c, id] = key.split('/') as [keyof PackManifest, string]
      const list = manifest[c] as AnyItem[] | undefined
      const i = list?.findIndex((x) => x.id === id) ?? -1
      if (list && i >= 0) list.splice(i, 1)
      dropped.push({ ref: `${LIVE_PACK}/${id}`, reason })
    }
  }
  const msValidate = performance.now() - tv
  for (const d of dropped) {
    const i = added.indexOf(d.ref)
    if (i >= 0) added.splice(i, 1)
  }

  // 4. stage files, render thumbnails, hash, publish.
  const staging = await stagingDir(o.root)
  const packDir = path.join(staging, LIVE_PACK)
  let msThumbs = 0
  try {
    await mkdir(packDir, { recursive: true })
    const usedLuts = new Set(manifest.filters.map((f) => f.lut))
    for (const [rel, src] of lutCopies) {
      if (!usedLuts.has(rel)) continue
      await mkdir(path.dirname(path.join(packDir, rel)), { recursive: true })
      await copyFile(src, path.join(packDir, ...rel.split('/')))
    }
    o.signal?.throwIfAborted()
    if (!o.skipThumbs) {
      if (!o.base.dir) throw new Error('no base pack tree for fonts')
      const th = performance.now()
      const refManifests = baseManifests
        .filter((m) => m.id === BASE_PACK)
        .map((m) => ({ dir: path.join(o.base.dir!, m.id), manifest: m }))
      await generateThumbs({
        manifests: [{ dir: packDir, manifest }],
        refManifests,
        fontFiles: await listFontFiles(path.join(o.base.dir, 'fonts')),
        ffmpegPath: o.ffmpeg,
        concurrency: o.concurrency ?? 2,
      })
      msThumbs = performance.now() - th
    }
    const files = await walk(packDir)
    manifest.files = await Promise.all(
      files.map(async (rel) => {
        const buf = await readFile(path.join(packDir, ...rel.split('/')))
        return { path: rel, sha256: sha256(buf), size: buf.length }
      }),
    )
    if (!o.skipThumbs) {
      const present = new Set(files)
      for (const [c] of Object.entries(THUMB_KINDS))
        for (const item of manifest[c as LiveCollection] as AnyItem[])
          if (item.thumb && !present.has(item.thumb))
            throw new Error(`thumbnail missing: ${item.thumb}`)
    }
    manifest = PackManifest.parse(manifest)
    await writeFile(path.join(packDir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    o.signal?.throwIfAborted()
    const dir = await activateLocalTree(o.root, staging, manifest.version, o.log)
    return {
      manifest,
      dir: path.join(dir, LIVE_PACK),
      dropped,
      added,
      ms: {
        validate: Math.round(msValidate),
        thumbs: Math.round(msThumbs),
        total: Math.round(performance.now() - t0),
      },
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}
