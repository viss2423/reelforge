/**
 * Semantic validation of trend packs beyond what the zod schemas express: ids, refs and
 * pack dependencies, animation shape, template timing, fonts, LUT and sticker files.
 * Returns human-readable error strings; the caller decides how loudly to fail.
 */
import { BUILTIN_ANIMATIONS as CORE_BUILTINS } from '../../packages/core/src/builtins.ts'

/** Builtin text animation ids implemented in core (`builtin/<id>`). */
export const BUILTIN_ANIMATIONS = CORE_BUILTINS.map((a) => a.id)

/** The base pack every other pack may depend on. Packs may not depend on each other. */
export const BASE_PACK = 'essentials'

/** Ids become ref segments and file names: keep them URL- and filesystem-safe. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Project-model limits for a transition (schema.ts `Transition`). */
const TRANSITION_MIN = 50_000
const TRANSITION_MAX = 3_000_000

const IDENTITY = { opacity: 1, scale: 1, x: 0, y: 0, rotation: 0 }

/** Item collections that carry a `thumb`, mapped to their thumbnail kind prefix. */
export const THUMB_KINDS = {
  filters: 'filter',
  captionStyles: 'caption',
  textPresets: 'text',
  templates: 'template',
}

export const COLLECTIONS = [
  'captionStyles',
  'textPresets',
  'filters',
  'animations',
  'transitions',
  'effects',
  'stickers',
  'templates',
]

/**
 * Parse and validate a .cube 3D LUT. Returns the LUT size.
 * @param {string} text
 */
export function parseCube(text) {
  let size = 0
  let rows = 0
  let domainOk = true
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('TITLE')) continue
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1])
      continue
    }
    if (line.startsWith('DOMAIN_MIN')) {
      domainOk &&= line
        .split(/\s+/)
        .slice(1)
        .every((v) => Number(v) === 0)
      continue
    }
    if (line.startsWith('DOMAIN_MAX')) {
      domainOk &&= line
        .split(/\s+/)
        .slice(1)
        .every((v) => Number(v) === 1)
      continue
    }
    if (line.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported')
    const parts = line.split(/\s+/)
    if (parts.length !== 3) throw new Error(`bad LUT row "${line}"`)
    for (const p of parts) {
      const v = Number(p)
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`LUT value out of range "${line}"`)
    }
    rows++
  }
  if (!Number.isInteger(size) || size < 2 || size > 65) throw new Error(`bad LUT_3D_SIZE ${size}`)
  if (!domainOk) throw new Error('LUT domain must be 0..1')
  if (rows !== size ** 3) throw new Error(`LUT has ${rows} rows, expected ${size ** 3}`)
  return size
}

/**
 * @param {{
 *   manifests: any[],            // parsed (zod) PackManifest objects
 *   fonts: { family: string, files: { weight: number, italic: boolean }[] }[],
 *   fileExists: (packId: string, rel: string) => boolean,
 * }} input
 * @returns {string[]} errors
 */
export function validatePacks({ manifests, fonts, fileExists }) {
  const errors = []
  const err = (where, msg) => errors.push(`${where}: ${msg}`)

  /** `<pack>/<id>` → item, per collection */
  const registry = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]))
  const packIds = new Set()
  for (const m of manifests) {
    if (packIds.has(m.id)) err(m.id, 'duplicate pack id')
    packIds.add(m.id)
    if (!ID_RE.test(m.id)) err(m.id, 'pack id must be a lowercase slug')
    if (!/^\d+\.\d+\.\d+$/.test(m.version)) err(m.id, `version "${m.version}" is not x.y.z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.curatedAt)) err(m.id, 'curatedAt must be YYYY-MM-DD')
    for (const c of COLLECTIONS) {
      for (const item of m[c]) {
        const ref = `${m.id}/${item.id}`
        if (!ID_RE.test(item.id)) err(ref, `${c} id must be a lowercase slug`)
        if (registry[c].has(ref)) err(ref, `duplicate id in ${c}`)
        registry[c].set(ref, item)
      }
    }
  }

  const resolve = (from, where, collection, ref, kind) => {
    const [packId, id, extra] = ref.split('/')
    const item = registry[collection].get(ref)
    if (collection === 'animations' && packId === 'builtin') {
      if (!BUILTIN_ANIMATIONS.includes(ref.slice(8))) err(where, `unknown builtin animation ${ref}`)
    } else if (!packId || !id || extra !== undefined) err(where, `malformed ref "${ref}"`)
    else if (packId !== from && packId !== BASE_PACK)
      err(where, `ref ${ref} crosses packs (only "${BASE_PACK}" may be depended on)`)
    else if (!item) err(where, `unresolved ${collection} ref ${ref}`)
    else if (kind && item.kind !== kind)
      err(where, `${ref} is a "${item.kind}" animation, expected "${kind}"`)
  }

  const fontIndex = new Map(fonts.map((f) => [f.family, f.files]))
  const checkFont = (where, style) => {
    const files = fontIndex.get(style.fontFamily)
    if (!files) err(where, `font family "${style.fontFamily}" is not shipped in packs/fonts`)
    else if (!files.some((f) => f.weight === style.fontWeight && f.italic === style.italic))
      err(
        where,
        `font "${style.fontFamily}" has no ${style.fontWeight}${style.italic ? ' italic' : ''} file`,
      )
  }

  for (const m of manifests) {
    const at = (c, id) => `${m.id}/${c}/${id}`

    for (const [c, kind] of Object.entries(THUMB_KINDS)) {
      for (const item of m[c]) {
        if (!item.thumb) err(at(c, item.id), 'missing thumbnail (run build-packs --generate)')
        else if (!fileExists(m.id, item.thumb)) err(at(c, item.id), `thumb ${item.thumb} missing`)
        else if (item.thumb !== `thumbs/${kind}-${item.id}.webp`)
          err(at(c, item.id), `thumb should be thumbs/${kind}-${item.id}.webp`)
      }
    }

    for (const cs of m.captionStyles) checkFont(at('captionStyles', cs.id), cs.style.base)

    for (const tp of m.textPresets) {
      const where = at('textPresets', tp.id)
      checkFont(where, tp.style)
      if (tp.animationIn) resolve(m.id, where, 'animations', tp.animationIn, 'in')
      if (tp.animationOut) resolve(m.id, where, 'animations', tp.animationOut, 'out')
      if (tp.animationLoop) resolve(m.id, where, 'animations', tp.animationLoop, 'loop')
    }

    for (const f of m.filters) {
      if (!f.lut.endsWith('.cube')) err(at('filters', f.id), 'lut must be a .cube file')
      if (!fileExists(m.id, f.lut)) err(at('filters', f.id), `lut ${f.lut} missing`)
    }

    for (const a of m.animations) checkAnimation(at('animations', a.id), a, err)

    for (const t of m.transitions) {
      if (t.duration < TRANSITION_MIN || t.duration > TRANSITION_MAX)
        err(
          at('transitions', t.id),
          `duration ${t.duration} outside ${TRANSITION_MIN}..${TRANSITION_MAX}`,
        )
    }

    for (const s of m.stickers) {
      if (!fileExists(m.id, s.file)) err(at('stickers', s.id), `file ${s.file} missing`)
      if (s.width <= 0 || s.height <= 0) err(at('stickers', s.id), 'width/height must be positive')
    }

    for (const t of m.templates) {
      const where = at('templates', t.id)
      if (t.slots.length === 0) err(where, 'template has no slots')
      if (t.captionStyle) resolve(m.id, where, 'captionStyles', t.captionStyle)
      t.slots.forEach((s, i) => {
        const w = `${where}/slots[${i}]`
        if (s.duration <= 0) err(w, 'slot duration must be positive')
        if (s.filter) resolve(m.id, w, 'filters', s.filter)
        for (const e of s.effects) resolve(m.id, w, 'effects', e)
        if (s.text) resolve(m.id, w, 'textPresets', s.text.preset)
        if (s.transitionIn) {
          const d = s.transitionIn.duration
          if (i === 0) err(w, 'first slot cannot have a transitionIn')
          if (d < TRANSITION_MIN || d > TRANSITION_MAX)
            err(w, `transition duration ${d} out of range`)
          const prev = t.slots[i - 1]
          if (d * 2 > s.duration || (prev && d * 2 > prev.duration))
            err(w, `transition ${d}us exceeds half of an adjacent slot`)
        }
      })
    }
  }
  return errors
}

/**
 * Animation keyframe shape: per track t strictly increasing within 0..1; `in` ends at the
 * identity pose, `out` starts at it, `loop` starts and ends at the same value (seamless).
 */
function checkAnimation(where, a, err) {
  const tracks = Object.entries(a.tracks).filter(([, kfs]) => kfs !== undefined)
  if (tracks.length === 0) err(where, 'animation has no tracks')
  for (const [prop, kfs] of tracks) {
    const w = `${where}.${prop}`
    if (kfs.length < 2) {
      err(w, 'track needs at least two keyframes')
      continue
    }
    for (let i = 1; i < kfs.length; i++)
      if (!(kfs[i].t > kfs[i - 1].t)) err(w, 'keyframe t must be strictly increasing')
    // Values hold before the first and after the last keyframe, so the first/last values
    // are what the track shows at t=0 and t=1.
    const first = kfs[0]
    const last = kfs[kfs.length - 1]
    const id = IDENTITY[prop]
    if (a.kind === 'in' && last.value !== id) err(w, `"in" animation must end at ${id}`)
    if (a.kind === 'out' && first.value !== id) err(w, `"out" animation must start at ${id}`)
    if (a.kind === 'loop' && first.value !== last.value) err(w, 'loop must start and end equal')
    if (prop === 'opacity' && kfs.some((k) => k.value < 0 || k.value > 1))
      err(w, 'opacity must stay within 0..1')
    if (prop === 'scale' && kfs.some((k) => k.value < 0)) err(w, 'scale must be >= 0')
  }
}
