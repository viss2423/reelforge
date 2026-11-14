#!/usr/bin/env node
/**
 * Trend pack build tool.
 *
 *   node scripts/build-packs.mjs              rebuild derived fields + index.json, validate
 *   node scripts/build-packs.mjs --generate   also regenerate LUTs, stickers and thumbnails
 *                                             (needs FFmpeg with libass + libwebp) and prove
 *                                             every font face resolves in libass
 *   node scripts/build-packs.mjs --check      validate and fail if anything is out of date
 *                                             (CI); writes nothing
 *
 * pack.json files are the hand-edited source. This tool owns only their derived fields —
 * `files[]` (path/sha256/size of every pack file), item `thumb` paths and sticker
 * `width`/`height` — plus all of packs/index.json. Output is formatted with the repo's
 * Prettier config, so the same inputs always produce byte-identical files.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as prettier from 'prettier'
import { PackIndex, PackManifest } from '../packages/core/src/index.ts'
import { verifyFontsWithLibass } from './lib-packs/fontcheck.mjs'
import { allJobs, generateAll } from './lib-packs/generate.mjs'
import { readPngHeader } from './lib-packs/png.mjs'
import { STICKERS } from './lib-packs/stickers.mjs'
import { generateThumbs, listFontFiles, pool, thumbPath } from './lib-packs/thumbs.mjs'
import { readFontInfo } from './lib-packs/ttf.mjs'
import { BASE_PACK, THUMB_KINDS, parseCube, validatePacks } from './lib-packs/validate.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKS = path.join(ROOT, 'packs')
const FONTS = path.join(PACKS, 'fonts')

const { values: flags } = parseArgs({
  options: { generate: { type: 'boolean' }, check: { type: 'boolean' } },
})
if (flags.generate && flags.check) fail(['--generate and --check are mutually exclusive'])

const log = (msg) => process.stdout.write(`${msg}\n`)
function fail(errors) {
  process.stderr.write(`\nbuild-packs FAILED (${errors.length}):\n  - ${errors.join('\n  - ')}\n`)
  process.exit(1)
}

const toPosix = (p) => p.split(path.sep).join('/')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

/** Every file under `dir` (recursive), as sorted posix paths relative to `dir`. */
async function walk(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => toPosix(path.relative(dir, path.join(e.parentPath, e.name))))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)) // code-unit order, locale-independent
}

/** sha256/size of files, hashed with bounded parallel reads. */
async function describe(dir, rels) {
  const out = Array.from({ length: rels.length })
  await pool(
    rels.map((rel, i) => async () => {
      const buf = await readFile(path.join(dir, rel))
      out[i] = { path: rel, sha256: sha256(buf), size: buf.length }
    }),
    16,
  )
  return out
}

const prettierConfig = (await prettier.resolveConfig(path.join(PACKS, 'index.json'))) ?? {}
const formatJson = (value) =>
  prettier.format(JSON.stringify(value), { ...prettierConfig, parser: 'json' })

/* ------------------------------------------------------------------ discover */

const packDirs = (await readdir(PACKS, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && existsSync(path.join(PACKS, d.name, 'pack.json')))
  .map((d) => d.name)
  .toSorted()
if (!packDirs.includes(BASE_PACK)) fail([`base pack "${BASE_PACK}" is missing`])

/** @type {{ id: string, dir: string, raw: any }[]} */
const packs = await Promise.all(
  packDirs.map(async (id) => ({
    id,
    dir: path.join(PACKS, id),
    raw: await readJson(path.join(PACKS, id, 'pack.json')),
  })),
)
for (const p of packs)
  if (p.raw.id !== p.id) fail([`packs/${p.id}/pack.json has id "${p.raw.id}" (must match folder)`])

/* ------------------------------------------------------------------ generate */

if (flags.generate) {
  const t0 = performance.now()
  // Resolve every generated asset to its pack entry first, so a typo fails before any work.
  const target = (packId, collection, id, field) => {
    const pack = packs.find((p) => p.id === packId)
    const preset = pack?.raw[collection]?.find((x) => x.id === id)
    if (!pack || !preset)
      fail([`generated ${packId}/${id} has no ${collection} entry in pack.json`])
    return { file: path.join(pack.dir, preset[field]), name: preset.name }
  }
  const lutTarget = (ref) => {
    const [packId, id] = ref.split('/')
    return target(packId, 'filters', id, 'lut')
  }
  const jobs = allJobs((ref) => lutTarget(ref).name)
  const dests = jobs.map((job) => {
    if (job.kind === 'lut') return lutTarget(job.ref).file
    const s = STICKERS[job.index]
    return target(s.pack, 'stickers', s.id, 'file').file
  })
  const outputs = await generateAll(jobs)
  await Promise.all(
    outputs.map(async (bytes, i) => {
      await mkdir(path.dirname(dests[i]), { recursive: true })
      await writeFile(dests[i], bytes)
    }),
  )
  const t1 = performance.now()
  log(
    `generated ${jobs.length - STICKERS.length} LUTs + ${STICKERS.length} stickers in ${Math.round(t1 - t0)} ms`,
  )

  const fontFiles = await listFontFiles(FONTS)
  const thumbs = await generateThumbs({
    manifests: packs.map((p) => ({ dir: p.dir, manifest: p.raw })),
    fontFiles,
  })
  const t2 = performance.now()
  log(`generated ${thumbs} thumbnails in ${Math.round(t2 - t1)} ms`)

  const faces = await Promise.all(
    fontFiles.map(async (file) => ({ file, ...readFontInfo(await readFile(file)) })),
  )
  const fontErrors = await verifyFontsWithLibass(faces)
  if (fontErrors.length) fail(fontErrors)
  log(`libass resolves all ${faces.length} font faces correctly`)
}

/* ------------------------------------------------------------------ derive pack fields */

/**
 * Derive one pack's generated fields (mutating `p.raw`) and validate its files. Problems are
 * returned rather than thrown so a single run reports everything, in a stable order.
 */
async function derivePack(p) {
  const raw = p.raw
  const files = (await walk(p.dir)).filter((f) => f !== 'pack.json')
  const present = new Set(files)

  // Thumbnails: point each item at its generated thumb (or drop a stale pointer).
  for (const [collection, kind] of Object.entries(THUMB_KINDS)) {
    for (const item of raw[collection] ?? []) {
      const rel = thumbPath(kind, item.id)
      if (present.has(rel)) item.thumb = rel
      else delete item.thumb
    }
  }

  const [stickerErrors, lutErrors, described] = await Promise.all([
    // Sticker pixel size comes from the PNG itself.
    Promise.all(
      (raw.stickers ?? [])
        .filter((s) => present.has(s.file) && s.file.endsWith('.png'))
        .map(async (s) => {
          const head = readPngHeader(await readFile(path.join(p.dir, s.file)))
          s.width = head.width
          s.height = head.height
          return head.colorType === 6 && head.bitDepth === 8
            ? []
            : [`${p.id}/stickers/${s.id}: must be 8-bit RGBA PNG (transparent background)`]
        }),
    ),
    Promise.all(
      (raw.filters ?? [])
        .filter((f) => present.has(f.lut))
        .map(async (f) => {
          try {
            const size = parseCube(await readFile(path.join(p.dir, f.lut), 'utf8'))
            return size === 33 ? [] : [`${p.id}/filters/${f.id}: LUT must be 33³ (got ${size}³)`]
          } catch (e) {
            return [`${p.id}/filters/${f.id}: ${e.message}`]
          }
        }),
    ),
    describe(p.dir, files),
  ])
  const errors = [...stickerErrors.flat(), ...lutErrors.flat()]

  // Every file must be referenced: orphans are stale generator output or mistakes.
  const referenced = new Set([
    ...(raw.filters ?? []).map((f) => f.lut),
    ...(raw.stickers ?? []).map((s) => s.file),
    ...Object.keys(THUMB_KINDS).flatMap((c) => (raw[c] ?? []).map((i) => i.thumb)),
  ])
  for (const f of files) if (!referenced.has(f)) errors.push(`${p.id}: unreferenced file ${f}`)

  raw.files = described
  const parsed = PackManifest.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      errors.push(`${p.id}/pack.json ${issue.path.join('.')}: ${issue.message}`)
    return { errors }
  }
  return { errors, manifest: parsed.data, output: await formatJson(raw) }
}

const errors = []
const manifests = []
const outputs = new Map() // absolute path → formatted text
for (const [i, result] of (await Promise.all(packs.map(derivePack))).entries()) {
  errors.push(...result.errors)
  if (!result.manifest) continue
  manifests.push(result.manifest)
  outputs.set(path.join(packs[i].dir, 'pack.json'), result.output)
}

/* ------------------------------------------------------------------ fonts */

const LICENSES = { 'OFL.txt': 'OFL-1.1', 'LICENSE.txt': 'Apache-2.0' }

/** Describe one font family folder as an index `fonts[]` entry, plus any problems found. */
async function describeFamily(family) {
  const problems = []
  const dir = path.join(FONTS, family)
  const names = (await readdir(dir)).toSorted()
  const licenseFile = names.find((n) => n in LICENSES)
  if (!licenseFile) problems.push(`fonts/${family}: missing OFL.txt / LICENSE.txt`)
  const ttfs = names.filter((n) => n.toLowerCase().endsWith('.ttf'))
  if (ttfs.length === 0) problems.push(`fonts/${family}: no .ttf files`)
  const buffers = await Promise.all(ttfs.map((name) => readFile(path.join(dir, name))))
  const files = ttfs.map((name, i) => {
    const buf = buffers[i]
    const info = readFontInfo(buf)
    const where = `fonts/${family}/${name}`
    if (info.family !== family)
      problems.push(
        `${where}: name ID 1 is "${info.family}" (libass matches it; must be "${family}")`,
      )
    if (info.variable) problems.push(`${where}: variable fonts render only their default instance`)
    return {
      path: where,
      sha256: sha256(buf),
      size: buf.length,
      weight: info.weight,
      italic: info.italic,
    }
  })
  files.sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic))
  for (let i = 1; i < files.length; i++)
    if (files[i].weight === files[i - 1].weight && files[i].italic === files[i - 1].italic)
      problems.push(`fonts/${family}: two files for weight ${files[i].weight}`)
  return { problems, entry: { family, license: LICENSES[licenseFile] ?? 'OFL-1.1', files } }
}

const families = await Promise.all(
  (await readdir(FONTS, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted()
    .map(describeFamily),
)
for (const f of families) errors.push(...f.problems)
const fonts = families.map((f) => f.entry)
const fontBytes = fonts.flatMap((f) => f.files).reduce((n, f) => n + f.size, 0)
if (fontBytes > 20 * 1024 * 1024) errors.push(`fonts total ${fontBytes} B exceeds 20 MB budget`)

/* ------------------------------------------------------------------ semantic validation */

const packFile = new Map(packs.map((p) => [p.id, new Set(p.raw.files.map((f) => f.path))]))
errors.push(
  ...validatePacks({
    manifests,
    fonts,
    fileExists: (packId, rel) => packFile.get(packId)?.has(rel) ?? false,
  }),
)

/* ------------------------------------------------------------------ index.json */

const indexPath = path.join(PACKS, 'index.json')
const prevIndex = existsSync(indexPath) ? await readJson(indexPath) : {}
const prevEntry = new Map((prevIndex.packs ?? []).map((e) => [e.id, e]))
// Base pack first, then most recently curated, then id — stable and useful for UIs.
const ordered = manifests.toSorted(
  (a, b) =>
    Number(b.id === BASE_PACK) - Number(a.id === BASE_PACK) ||
    b.curatedAt.localeCompare(a.curatedAt) ||
    a.id.localeCompare(b.id),
)
const curated =
  manifests
    .map((m) => m.curatedAt)
    .toSorted()
    .at(-1) ?? '1970-01-01'
// Index tags are curated by hand in index.json (manifests have none) and carried over.
const entries = ordered.map((m) => ({
  id: m.id,
  version: m.version,
  name: m.name,
  description: m.description,
  curatedAt: m.curatedAt,
  tags: prevEntry.get(m.id)?.tags ?? [],
}))
// Content-addressed version: date of the newest curation + hash of the entries, every pack
// manifest and font file, so any change publishes a new index and identical content never does.
const contentHash = createHash('sha256').update(`${JSON.stringify(entries)}\n`)
for (const m of ordered) contentHash.update(`${outputs.get(path.join(PACKS, m.id, 'pack.json'))}\n`)
for (const f of fonts.flatMap((x) => x.files)) contentHash.update(`${f.path}:${f.sha256}\n`)
const [y, mo, d] = curated.split('-').map(Number)

const index = {
  version: `${y}.${mo}.${d}+${contentHash.digest('hex').slice(0, 12)}`,
  updatedAt: curated,
  minAppVersion: prevIndex.minAppVersion ?? '0.1.0',
  packs: entries,
  fonts,
}
const parsedIndex = PackIndex.safeParse(index)
if (!parsedIndex.success)
  for (const issue of parsedIndex.error.issues)
    errors.push(`index.json ${issue.path.join('.')}: ${issue.message}`)
outputs.set(indexPath, await formatJson(index))

if (errors.length) fail(errors)

/* ------------------------------------------------------------------ write / check */

const stale = (
  await Promise.all(
    [...outputs].map(async ([file, text]) => {
      const current = existsSync(file) ? await readFile(file, 'utf8') : ''
      if (current === text) return []
      if (flags.check) return [toPosix(path.relative(ROOT, file))]
      await writeFile(file, text)
      return []
    }),
  )
).flat()
if (stale.length) fail(stale.map((f) => `${f} is out of date — run node scripts/build-packs.mjs`))

const count = (c) => manifests.reduce((n, m) => n + m[c].length, 0)
log(
  `${flags.check ? 'checked' : 'built'} ${manifests.length} packs (index ${index.version}): ` +
    `${count('captionStyles')} caption styles, ${count('textPresets')} text presets, ` +
    `${count('animations')} animations, ${count('filters')} filters, ` +
    `${count('transitions')} transitions, ${count('effects')} effects, ` +
    `${count('stickers')} stickers, ${count('templates')} templates, ` +
    `${fonts.length} font families (${(fontBytes / 1048576).toFixed(1)} MB)`,
)
