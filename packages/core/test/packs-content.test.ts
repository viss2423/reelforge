/**
 * Content tests for the trend packs shipped in the repo (`packs/`).
 *
 * Every install syncs these files, so a broken ref, a stale hash or a missing font weight
 * would break all users at once. The checks here are deliberately independent of
 * scripts/build-packs.mjs (which also validates) — except the last test, which runs its
 * `--check` mode to prove the committed derived files are byte-identical to a rebuild.
 *
 * Most tests collect human-readable problems and assert the list is empty, so a failure
 * names every offending item at once instead of stopping at the first.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { BUILTIN_ANIMATIONS } from '../src/builtins.ts'
import { EffectPreset, PackIndex, PackManifest } from '../src/packs.ts'
import { CaptionStyle, TransitionType } from '../src/schema.ts'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const PACKS = path.join(ROOT, 'packs')
const BASE_PACK = 'essentials'
const TRENDING_PACK = 'trending-2026-11'

/** Families that styles may use (shared builder convention) — all must ship. */
const REQUIRED_FAMILIES = [
  'Montserrat',
  'Poppins',
  'Inter',
  'Bebas Neue',
  'Anton',
  'Oswald',
  'Archivo Black',
  'Bangers',
  'Permanent Marker',
  'Pacifico',
  'Lilita One',
  'Roboto',
  'Playfair Display',
  'Caveat',
  'Rubik',
]

/** Builtin text animations implemented in core (`builtin/<id>`). */
const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_ANIMATIONS.map((a) => a.id))

/** Brand / creator names that must never appear in shipped content (we name things generically). */
const BANNED = /tiktok|instagram|youtube|capcut|hormozi|mrbeast|snapchat|netflix|spotify|disney/i

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const TRANSITION_MIN = 50_000
const TRANSITION_MAX = 3_000_000
const LUT_SIZE = 33
/** Resting pose of each animatable property: `in` lands on it, `out` leaves from it. */
const IDENTITY = { opacity: 1, scale: 1, x: 0, y: 0, rotation: 0 } as const
const TRACKS = ['opacity', 'scale', 'x', 'y', 'rotation'] as const

/* ------------------------------------------------------------------ fixtures */

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')
/** Code-unit string order (what the build tool uses), independent of locale. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const sorted = (items: Iterable<string>) => [...items].toSorted(byCodeUnit)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

const index = PackIndex.parse(readJson(path.join(PACKS, 'index.json')))
const packDirs = sorted(
  readdirSync(PACKS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(PACKS, d.name, 'pack.json')))
    .map((d) => d.name),
)
const manifests = packDirs.map((id) =>
  PackManifest.parse(readJson(path.join(PACKS, id, 'pack.json'))),
)
type Manifest = (typeof manifests)[number]

const COLLECTIONS = [
  'captionStyles',
  'textPresets',
  'filters',
  'animations',
  'transitions',
  'effects',
  'stickers',
  'templates',
] as const
type Collection = (typeof COLLECTIONS)[number]

/** The fields every pack item shares (plus an animation's kind), for collection-generic checks. */
interface Item {
  id: string
  trendScore: number
  kind?: string
}
const itemsOf = (m: Manifest, c: Collection): readonly Item[] => m[c]
const trendScores = (m: Manifest) =>
  COLLECTIONS.flatMap((c) => itemsOf(m, c).map((i) => i.trendScore))

/** Items of one collection across all packs, each with the id of the pack that ships it. */
const all = <C extends Collection>(c: C) =>
  manifests.flatMap((m) => m[c].map((item: Manifest[C][number]) => ({ pack: m.id, item })))

/** `<pack>/<id>` → item, per collection. */
const registry = new Map(
  COLLECTIONS.map((c) => [
    c,
    new Map<string, Item>(
      manifests.flatMap((m) => itemsOf(m, c).map((i) => [`${m.id}/${i.id}`, i] as const)),
    ),
  ]),
)

/**
 * Resolve a `<pack>/<id>` ref the way the app does; returns a problem or undefined.
 * A pack may reference itself and the base pack, never another trend pack (packs update
 * independently, so cross-pack refs could dangle).
 */
function refProblem(from: string, c: Collection, ref: string, kind?: string): string | undefined {
  const parts = ref.split('/')
  if (c === 'animations' && parts[0] === 'builtin')
    return BUILTIN_IDS.has(parts[1] ?? '') ? undefined : `unknown builtin ${ref}`
  if (parts.length !== 2) return `malformed ref ${ref}`
  if (parts[0] !== from && parts[0] !== BASE_PACK) return `cross-pack ref ${ref}`
  const item = registry.get(c)?.get(ref)
  if (!item) return `unresolved ${c} ref ${ref}`
  if (kind && item.kind !== kind) return `${ref} is "${item.kind}", expected "${kind}"`
  return undefined
}

/** Minimal TrueType reader: name ID 1 (what libass matches), weight class, italic bit. */
function readFont(buf: Buffer) {
  const tables = new Map<string, number>()
  for (let i = 0; i < buf.readUInt16BE(4); i++) {
    const rec = 12 + i * 16
    tables.set(buf.toString('latin1', rec, rec + 4), buf.readUInt32BE(rec + 8))
  }
  const nameOff = tables.get('name')
  const os2 = tables.get('OS/2')
  if (nameOff === undefined || os2 === undefined) throw new Error('missing name/OS2 table')
  const strings = nameOff + buf.readUInt16BE(nameOff + 4)
  let family = ''
  for (let i = 0; i < buf.readUInt16BE(nameOff + 2); i++) {
    const r = nameOff + 6 + i * 12
    // Windows platform, en-US, name ID 1: UTF-16BE.
    if (buf.readUInt16BE(r) !== 3 || buf.readUInt16BE(r + 4) !== 0x409) continue
    if (buf.readUInt16BE(r + 6) !== 1) continue
    const off = strings + buf.readUInt16BE(r + 10)
    family = Buffer.from(buf.subarray(off, off + buf.readUInt16BE(r + 8)))
      .swap16()
      .toString('utf16le')
  }
  return {
    family,
    weight: buf.readUInt16BE(os2 + 4),
    italic: (buf.readUInt16BE(os2 + 62) & 1) === 1,
    variable: tables.has('fvar'),
  }
}

/** Decode a non-interlaced 8-bit RGBA PNG down to its alpha channel. */
function decodePngAlpha(buf: Buffer) {
  const header = {
    signature: buf.subarray(0, 8).toString('hex'),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const idat: Buffer[] = []
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p)
    if (buf.toString('latin1', p + 4, p + 8) === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const prev = new Uint8Array(stride)
  const row = new Uint8Array(stride)
  const alpha = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1)
    const filter = raw[base]
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4]! : 0
      const b = prev[x]!
      const c = x >= 4 ? prev[x - 4]! : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      row[x] = (raw[base + 1 + x]! + pred) & 0xff
    }
    for (let x = 0; x < width; x++) alpha[y * width + x] = row[x * 4 + 3]!
    prev.set(row)
  }
  return { header, width, height, alpha }
}

/**
 * Parse a .cube 3D LUT into a flat RGB array (36k rows per file, so no per-row arrays).
 * `badValues` counts malformed rows and values that are not finite numbers in 0..1.
 */
function parseCube(text: string) {
  let size = 0
  let badValues = 0
  const domain: string[] = []
  const values: number[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('TITLE')) continue
    if (line.startsWith('LUT_3D_SIZE')) size = Number(line.slice(11))
    else if (line.startsWith('DOMAIN_')) domain.push(line.replace(/\s+/g, ' '))
    else {
      const parts = line.split(' ')
      if (parts.length !== 3) badValues++
      for (const p of parts) {
        const v = Number(p)
        if (!(v >= 0 && v <= 1)) badValues++
        values.push(v)
      }
    }
  }
  return { size, domain, badValues, rgb: Float64Array.from(values) }
}

/** Largest per-channel distance from the identity LUT (red varies fastest in .cube). */
function maxDeltaFromIdentity(rgb: Float64Array) {
  const n = LUT_SIZE
  let max = 0
  for (let i = 0; i < n ** 3; i++) {
    const ident = [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))]
    for (let ch = 0; ch < 3; ch++)
      max = Math.max(max, Math.abs(rgb[i * 3 + ch]! - ident[ch]! / (n - 1)))
  }
  return max
}

/* ------------------------------------------------------------------ tests */

describe('packs index', () => {
  it('lists exactly the pack folders, base pack first', () => {
    expect(sorted(index.packs.map((p) => p.id))).toEqual(packDirs)
    expect(index.packs[0]?.id).toBe(BASE_PACK)
    expect(packDirs).toContain(TRENDING_PACK)
    expect(new Set(index.packs.map((p) => p.id)).size).toBe(index.packs.length)
  })

  it('mirrors each manifest id/version/name/curation date', () => {
    expect(manifests.map((m) => m.id)).toEqual(packDirs)
    for (const m of manifests) {
      expect(index.packs.find((p) => p.id === m.id)).toMatchObject({
        version: m.version,
        name: m.name,
        description: m.description,
        curatedAt: m.curatedAt,
      })
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(m.curatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(index.updatedAt).toBe(sorted(manifests.map((m) => m.curatedAt)).at(-1))
  })
})

describe('pack files', () => {
  it.each(manifests.map((m) => [m.id, m] as const))(
    '%s: files[] match disk exactly (paths, sha256, sizes)',
    (id, m) => {
      const dir = path.join(PACKS, id)
      const onDisk = sorted(
        readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
          .filter((f) => f !== 'pack.json'),
      )
      expect(m.files.map((f) => f.path)).toEqual(onDisk)
      const actual = m.files.map((f) => {
        const buf = readFileSync(path.join(dir, f.path))
        return { path: f.path, sha256: sha256(buf), size: buf.length }
      })
      expect(actual).toEqual(m.files)
    },
  )

  it('every referenced file is listed in files[]', () => {
    const problems: string[] = []
    for (const m of manifests) {
      const listed = new Set(m.files.map((f) => f.path))
      const refs = [
        ...m.filters.map((f) => f.lut),
        ...m.stickers.map((s) => s.file),
        ...[...m.captionStyles, ...m.textPresets, ...m.filters, ...m.templates].map(
          (i) => i.thumb ?? `<no thumb for ${i.id}>`,
        ),
      ]
      for (const ref of refs) if (!listed.has(ref)) problems.push(`${m.id}: ${ref}`)
    }
    expect(problems).toEqual([])
  })

  it('thumbnails are small WebP images', () => {
    const problems: string[] = []
    for (const m of manifests) {
      for (const item of [...m.captionStyles, ...m.textPresets, ...m.filters, ...m.templates]) {
        if (!item.thumb) continue // reported by the files[] test above
        const buf = readFileSync(path.join(PACKS, m.id, item.thumb))
        const magic = buf.toString('latin1', 0, 4) + buf.toString('latin1', 8, 12)
        if (magic !== 'RIFFWEBP') problems.push(`${m.id}/${item.thumb}: not WebP`)
        if (buf.length > 64 * 1024) problems.push(`${m.id}/${item.thumb}: ${buf.length} B`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('ids and scores', () => {
  it('ids are unique slugs within each collection', () => {
    const problems: string[] = []
    for (const m of manifests) {
      for (const c of COLLECTIONS) {
        const seen = new Set<string>()
        for (const { id } of itemsOf(m, c)) {
          if (seen.has(id)) problems.push(`${m.id}/${c}: duplicate ${id}`)
          if (!ID_RE.test(id)) problems.push(`${m.id}/${c}: bad id ${id}`)
          seen.add(id)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('trendScores are within 0..100 and the trending pack outranks the basics', () => {
    const everything = manifests.flatMap(trendScores)
    expect(Math.min(...everything)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...everything)).toBeLessThanOrEqual(100)
    const base = trendScores(manifests.find((m) => m.id === BASE_PACK)!)
    const trending = trendScores(manifests.find((m) => m.id === TRENDING_PACK)!)
    expect(mean(trending)).toBeGreaterThan(mean(base))
    // Scores must actually discriminate, or sorting by them is meaningless.
    expect(new Set(trending).size).toBeGreaterThanOrEqual(10)
  })

  it('never names brands or creators', () => {
    for (const m of manifests) expect(JSON.stringify({ ...m, files: [] })).not.toMatch(BANNED)
    expect(JSON.stringify(index.packs)).not.toMatch(BANNED)
  })
})

describe('coverage minimums', () => {
  it('ships enough of everything', () => {
    const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, all(c).length]))
    expect(counts.captionStyles).toBeGreaterThanOrEqual(24)
    expect(counts.textPresets).toBeGreaterThanOrEqual(30)
    expect(counts.animations).toBeGreaterThanOrEqual(30)
    expect(counts.filters).toBeGreaterThanOrEqual(24)
    expect(counts.transitions).toBeGreaterThanOrEqual(TransitionType.options.length)
    expect(counts.effects).toBeGreaterThanOrEqual(15)
    expect(counts.stickers).toBeGreaterThanOrEqual(30)
    expect(counts.templates).toBeGreaterThanOrEqual(16)
  })

  it('covers every caption mode, transition type, effect and animation kind', () => {
    expect(sorted(new Set(all('captionStyles').map(({ item }) => item.style.mode)))).toEqual(
      sorted(CaptionStyle.shape.mode.unwrap().options),
    )
    expect(sorted(new Set(all('transitions').map(({ item }) => item.type)))).toEqual(
      sorted(TransitionType.options),
    )
    expect(sorted(new Set(all('effects').map(({ item }) => item.effect)))).toEqual(
      sorted(EffectPreset.shape.effect.options),
    )
    const kinds = all('animations').map(({ item }) => item.kind)
    expect(kinds.filter((k) => k === 'in').length).toBeGreaterThanOrEqual(5)
    expect(kinds.filter((k) => k === 'out').length).toBeGreaterThanOrEqual(5)
    expect(kinds.filter((k) => k === 'loop').length).toBeGreaterThanOrEqual(5)
  })
})

describe('refs resolve', () => {
  it('text presets → animations of the right kind', () => {
    const problems: string[] = []
    for (const { pack, item: tp } of all('textPresets')) {
      const slots = [
        ['in', tp.animationIn],
        ['out', tp.animationOut],
        ['loop', tp.animationLoop],
      ] as const
      for (const [kind, ref] of slots) {
        const problem = ref === undefined ? undefined : refProblem(pack, 'animations', ref, kind)
        if (problem) problems.push(`${pack}/${tp.id}: ${problem}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('templates → caption styles, text presets, filters, effects', () => {
    const problems: string[] = []
    for (const { pack, item: t } of all('templates')) {
      const check = (c: Collection, ref: string | undefined) => {
        const problem = ref === undefined ? undefined : refProblem(pack, c, ref)
        if (problem) problems.push(`${pack}/${t.id}: ${problem}`)
      }
      check('captionStyles', t.captionStyle)
      for (const s of t.slots) {
        check('filters', s.filter)
        check('textPresets', s.text?.preset)
        for (const e of s.effects) check('effects', e)
      }
    }
    expect(problems).toEqual([])
  })

  it('the resolver rejects bad refs', () => {
    expect(refProblem(TRENDING_PACK, 'filters', `${BASE_PACK}/teal-orange`)).toBeUndefined()
    expect(refProblem(BASE_PACK, 'filters', `${TRENDING_PACK}/cyberpunk`)).toMatch(/cross-pack/)
    expect(refProblem(BASE_PACK, 'filters', `${BASE_PACK}/nope`)).toMatch(/unresolved/)
    expect(refProblem(BASE_PACK, 'filters', 'a/b/c')).toMatch(/malformed/)
    expect(refProblem(BASE_PACK, 'animations', 'builtin/pop')).toBeUndefined()
    expect(refProblem(BASE_PACK, 'animations', 'builtin/nope')).toMatch(/unknown builtin/)
  })
})

describe('fonts', () => {
  const families = new Map(index.fonts.map((f) => [f.family, f]))

  it('ships every required family, each with a licence', () => {
    expect(sorted(families.keys())).toEqual(sorted(REQUIRED_FAMILIES))
    const unlicensed = REQUIRED_FAMILIES.filter((family) =>
      ['OFL.txt', 'LICENSE.txt'].every((n) => !existsSync(path.join(PACKS, 'fonts', family, n))),
    )
    expect(unlicensed).toEqual([])
  })

  it('font files match their hashes, and libass sees the right family/weight', () => {
    const files = index.fonts.flatMap((f) => f.files.map((file) => ({ family: f.family, file })))
    const actual = files.map(({ file }) => {
      const buf = readFileSync(path.join(PACKS, file.path))
      return { path: file.path, sha256: sha256(buf), size: buf.length, ...readFont(buf) }
    })
    const expected = files.map(({ family, file }) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      family,
      weight: file.weight,
      italic: file.italic,
      variable: false,
    }))
    expect(actual).toEqual(expected)
    expect(actual.reduce((n, f) => n + f.size, 0)).toBeLessThan(20 * 1024 * 1024)
  })

  it('every family/weight/italic used by a style exists', () => {
    const used = [
      ...all('captionStyles').map(({ item }) => item.style.base),
      ...all('textPresets').map(({ item }) => item.style),
    ]
    const missing = used
      .filter(
        (s) =>
          !families
            .get(s.fontFamily)
            ?.files.some((f) => f.weight === s.fontWeight && f.italic === s.italic),
      )
      .map((s) => `${s.fontFamily} ${s.fontWeight}${s.italic ? ' italic' : ''}`)
    expect(sorted(new Set(missing))).toEqual([])
  })
})

describe('filters', () => {
  it.each(all('filters').map(({ pack, item }) => [item.id, pack, item.lut] as const))(
    '%s: LUT is a valid, non-identity 33³ cube',
    (_, pack, lut) => {
      expect(lut).toMatch(/^luts\/[a-z0-9-]+\.cube$/)
      const cube = parseCube(readFileSync(path.join(PACKS, pack, lut), 'utf8'))
      expect(cube.size).toBe(LUT_SIZE)
      expect(cube.domain).toEqual(['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'])
      expect(cube.badValues).toBe(0)
      expect(cube.rgb.length).toBe(3 * LUT_SIZE ** 3)
      // A look must visibly change the image.
      expect(maxDeltaFromIdentity(cube.rgb)).toBeGreaterThan(0.03)
    },
  )

  it('looks are distinct from one another', () => {
    // Skip the header: its TITLE differs even when the data would not.
    const data = all('filters').map(({ pack, item }) => {
      const text = readFileSync(path.join(PACKS, pack, item.lut), 'utf8')
      return sha256(Buffer.from(text.slice(text.indexOf('DOMAIN_MAX'))))
    })
    expect(new Set(data).size).toBe(data.length)
  })
})

describe('animations', () => {
  it.each(all('animations').map(({ item }) => [item.id, item] as const))(
    '%s: well-formed tracks',
    (_, a) => {
      const problems: string[] = []
      let tracks = 0
      for (const prop of TRACKS) {
        const kfs = a.tracks[prop]
        if (!kfs) continue
        tracks++
        const first = kfs[0]
        const last = kfs.at(-1)
        if (!first || !last || kfs.length < 2) {
          problems.push(`${prop}: needs two keyframes`)
          continue
        }
        if (kfs.some((k, i) => i > 0 && !(k.t > kfs[i - 1]!.t)))
          problems.push(`${prop}: t not strictly increasing`)
        // `in` lands on the resting pose, `out` leaves from it, `loop` is seamless.
        if (a.kind === 'in' && last.value !== IDENTITY[prop]) problems.push(`${prop}: in end`)
        if (a.kind === 'out' && first.value !== IDENTITY[prop]) problems.push(`${prop}: out start`)
        if (a.kind === 'loop' && first.value !== last.value) problems.push(`${prop}: loop seam`)
        if (prop === 'opacity' && kfs.some((k) => k.value < 0 || k.value > 1))
          problems.push('opacity outside 0..1')
      }
      expect(tracks).toBeGreaterThan(0)
      expect(problems).toEqual([])
    },
  )
})

describe('transitions and templates', () => {
  it('transition presets have usable durations', () => {
    const bad = all('transitions')
      .filter(({ item }) => item.duration < TRANSITION_MIN || item.duration > TRANSITION_MAX)
      .map(({ item }) => `${item.id}: ${item.duration}`)
    expect(bad).toEqual([])
  })

  it.each(all('templates').map(({ item }) => [item.id, item] as const))(
    '%s: beat-synced slots',
    (_, t) => {
      expect(t.slots.length).toBeGreaterThan(0)
      expect(t.musicHint?.bpm).toBeGreaterThan(0)
      const beat = 60_000_000 / (t.musicHint?.bpm ?? 1)
      const problems: string[] = []
      t.slots.forEach((s, i) => {
        // Cut points land on whole beats (durations rounded to the microsecond).
        const beats = Math.round(s.duration / beat)
        if (!Number.isInteger(s.duration)) problems.push(`slot ${i}: non-integer duration`)
        if (beats < 1 || Math.abs(s.duration - beats * beat) > 1)
          problems.push(`slot ${i}: ${s.duration}us is not a whole number of beats`)
        if (!s.transitionIn) return
        const d = s.transitionIn.duration
        const prev = t.slots[i - 1]
        if (!prev) problems.push('first slot has an incoming transition')
        if (d < TRANSITION_MIN || d > TRANSITION_MAX) problems.push(`slot ${i}: transition ${d}`)
        if (d * 2 > Math.min(s.duration, prev?.duration ?? 0))
          problems.push(`slot ${i}: transition longer than half a neighbouring slot`)
      })
      expect(problems).toEqual([])
    },
  )
})

describe('stickers', () => {
  it.each(all('stickers').map(({ pack, item }) => [item.id, pack, item] as const))(
    '%s: RGBA PNG with a transparent background',
    (_, pack, s) => {
      const png = decodePngAlpha(readFileSync(path.join(PACKS, pack, s.file)))
      expect(png.header).toEqual({
        signature: '89504e470d0a1a0a',
        bitDepth: 8,
        colorType: 6,
        interlace: 0,
      })
      expect([png.width, png.height]).toEqual([s.width, s.height])
      expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(1024)
      const { alpha, width } = png
      const clear = alpha.reduce((n, a) => n + (a === 0 ? 1 : 0), 0)
      // Some art (highlighter swipes) is deliberately translucent, so count any coverage.
      expect(clear).toBeGreaterThan(alpha.length * 0.05)
      expect(alpha.length - clear).toBeGreaterThan(alpha.length * 0.01)
      const corners = [0, width - 1, alpha.length - width, alpha.length - 1].map((i) => alpha[i])
      expect(corners).toEqual([0, 0, 0, 0])
    },
  )
})

describe('build tool', () => {
  it('committed pack.json/index.json are exactly what build-packs regenerates', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(ROOT, 'scripts/build-packs.mjs'), '--check'],
      { cwd: ROOT },
    )
    expect(stdout).toMatch(/^checked \d+ packs/)
  }, 60_000)
})
