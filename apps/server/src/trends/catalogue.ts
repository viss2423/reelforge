/**
 * The building blocks generated items may use, and the compilers that turn the LLM's
 * compact "specs" into real pack items.
 *
 * The LLM never writes pack JSON directly: it fills small, closed-vocabulary specs (fonts
 * from the shipped set, refs from the catalogue, beats instead of microseconds), and these
 * compilers produce schema-valid items with sane, beat-aligned timings. Anything unknown is
 * snapped to a safe default rather than rejected, then the result is validated like any
 * pack (validate.ts).
 */
import {
  CaptionStyle,
  TextStyle,
  TransitionType,
  type CaptionStylePreset,
  type PackIndex,
  type PackManifest,
  type TemplatePreset,
  type TextPreset,
} from '@reelforge/core'
import { z } from 'zod'
import { beatsUs, editTempo } from './bpm.ts'

export const LIVE_PACK = 'trending-live'
export const BASE_PACK = 'essentials'

/** Refs the LLM may pick from, grouped by role. */
export interface Catalogue {
  fonts: Map<string, Array<{ weight: number; italic: boolean }>>
  animations: { in: string[]; out: string[]; loop: string[] }
  effects: string[]
  filters: string[]
  textPresets: string[]
  captionStyles: string[]
  templates: string[]
  /** Base packs searched for refs: essentials + the newest monthly trend pack. */
  packs: PackManifest[]
}

const refsOf = <T extends { id: string }>(
  packs: readonly PackManifest[],
  pick: (m: PackManifest) => readonly T[],
  keep: (item: T) => boolean = () => true,
): string[] =>
  packs.flatMap((m) =>
    pick(m)
      .filter(keep)
      .map((i) => `${m.id}/${i.id}`),
  )

/** Builds the catalogue from the served base packs (never from the live pack itself). */
export const buildCatalogue = (
  manifests: readonly PackManifest[],
  index: PackIndex | undefined,
): Catalogue => {
  const base = manifests.find((m) => m.id === BASE_PACK)
  const newestTrend = manifests
    .filter((m) => m.id !== BASE_PACK && m.id !== LIVE_PACK)
    .toSorted((a, b) => b.curatedAt.localeCompare(a.curatedAt))[0]
  const packs = [base, newestTrend].filter((m): m is PackManifest => !!m)
  return {
    fonts: new Map(
      (index?.fonts ?? []).map((f) => [
        f.family,
        f.files.map((x) => ({ weight: x.weight, italic: x.italic })),
      ]),
    ),
    animations: {
      in: refsOf(
        packs,
        (m) => m.animations,
        (a) => a.kind === 'in',
      ),
      out: refsOf(
        packs,
        (m) => m.animations,
        (a) => a.kind === 'out',
      ),
      loop: refsOf(
        packs,
        (m) => m.animations,
        (a) => a.kind === 'loop',
      ),
    },
    effects: refsOf(packs, (m) => m.effects),
    filters: refsOf(packs, (m) => m.filters),
    textPresets: refsOf(packs, (m) => m.textPresets),
    captionStyles: refsOf(packs, (m) => m.captionStyles),
    templates: refsOf(packs, (m) => m.templates),
    packs,
  }
}

/* ------------------------------------------------------------------ specs (LLM output) */

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const Name = z.string().min(2).max(40)
const Tags = z.array(z.string().max(24)).max(6).default([])

export const CaptionSpec = z.object({
  name: Name,
  tags: Tags,
  font: z.string(),
  weight: z.number().int().min(100).max(900),
  uppercase: z.boolean(),
  mode: z.enum(['karaoke', 'word-by-word', 'line', 'pop', 'bounce', 'typewriter']),
  color: Hex,
  activeColor: Hex,
  keywordColor: Hex,
  strokeWidth: z.number().min(0).max(14),
  background: Hex.optional(),
  wordsPerLine: z.number().int().min(1).max(5),
  position: z.enum(['upper', 'middle', 'lower']),
})
export type CaptionSpec = z.infer<typeof CaptionSpec>

export const TextSpec = z.object({
  name: Name,
  tags: Tags,
  sampleText: z.string().min(1).max(60),
  font: z.string(),
  weight: z.number().int().min(100).max(900),
  size: z.number().min(40).max(150),
  color: Hex,
  strokeColor: Hex,
  strokeWidth: z.number().min(0).max(14),
  uppercase: z.boolean(),
  background: Hex.optional(),
  animationIn: z.string(),
  animationOut: z.string(),
})
export type TextSpec = z.infer<typeof TextSpec>

export const TemplateSpec = z.object({
  name: Name,
  description: z.string().max(160),
  tags: Tags,
  /** Name of a trending sound from the prompt, or "" for none. */
  sound: z.string().max(80).default(''),
  bpm: z.number().min(60).max(200),
  /** Trend (topic/format/aesthetic) this template answers. */
  trend: z.string().max(60).default(''),
  filter: z.string().default(''),
  captionStyle: z.string().default(''),
  hookText: z.string().max(60),
  hookPreset: z.string(),
  slots: z
    .array(
      z.object({
        beats: z.number().int().min(1).max(16),
        kind: z.enum(['video', 'image', 'any']).default('any'),
        transition: z.string().default('cut'),
        effect: z.string().default(''),
        text: z.string().max(60).default(''),
      }),
    )
    .min(2)
    .max(16),
})
export type TemplateSpec = z.infer<typeof TemplateSpec>

/** JSON Schema of `{ items: Spec[] }` for constrained LLM decoding. */
export const listSchema = (item: z.ZodType, max: number): object =>
  z.toJSONSchema(z.object({ items: z.array(item).max(max) }), { io: 'input' })

/* ------------------------------------------------------------------ compilers */

export const slugify = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item'

/** A slug not in `taken` (adds -2, -3…); records it. */
export const uniqueId = (name: string, taken: Set<string>): string => {
  const base = slugify(name)
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/** Shipped family + nearest shipped upright weight (libass only matches exact faces). */
export const snapFont = (
  cat: Catalogue,
  family: string,
  weight: number,
): { fontFamily: string; fontWeight: number } => {
  const match = [...cat.fonts.keys()].find((f) => f.toLowerCase() === family.trim().toLowerCase())
  const fam = match ?? (cat.fonts.has('Montserrat') ? 'Montserrat' : [...cat.fonts.keys()][0])
  const weights = (cat.fonts.get(fam ?? '') ?? []).filter((f) => !f.italic).map((f) => f.weight)
  const w = weights.length
    ? weights.reduce((best, x) => (Math.abs(x - weight) < Math.abs(best - weight) ? x : best))
    : 400
  return { fontFamily: fam ?? 'Montserrat', fontWeight: w }
}

const pickRef = (ref: string, allowed: readonly string[], fallback: string | undefined) =>
  allowed.includes(ref) ? ref : fallback

const tagsOf = (tags: readonly string[]): string[] => [
  ...new Set(tags.map((t) => slugify(t)).filter((t) => t.length >= 2)),
]

const Y = { upper: 520, middle: 960, lower: 1300 } as const

export const compileCaption = (
  spec: CaptionSpec,
  cat: Catalogue,
  id: string,
  trendScore: number,
): CaptionStylePreset => ({
  id,
  name: spec.name,
  trendScore,
  tags: tagsOf(spec.tags),
  style: CaptionStyle.parse({
    base: {
      ...snapFont(cat, spec.font, spec.weight),
      fontSize: 84,
      color: spec.color.toUpperCase(),
      strokeWidth: spec.strokeWidth,
      uppercase: spec.uppercase,
      ...(spec.background ? { backgroundColor: spec.background.toUpperCase() } : {}),
    },
    mode: spec.mode,
    activeColor: spec.activeColor.toUpperCase(),
    keywordColor: spec.keywordColor.toUpperCase(),
    maxWordsPerLine: spec.wordsPerLine,
    y: Y[spec.position],
  }),
})

export const compileText = (
  spec: TextSpec,
  cat: Catalogue,
  id: string,
  trendScore: number,
): TextPreset => {
  const animationIn = pickRef(spec.animationIn, cat.animations.in, cat.animations.in[0])
  const animationOut = pickRef(spec.animationOut, cat.animations.out, cat.animations.out[0])
  return {
    id,
    name: spec.name,
    trendScore,
    tags: tagsOf(spec.tags),
    sampleText: spec.sampleText,
    style: TextStyle.parse({
      ...snapFont(cat, spec.font, spec.weight),
      fontSize: Math.round(spec.size),
      color: spec.color.toUpperCase(),
      strokeColor: spec.strokeColor.toUpperCase(),
      strokeWidth: spec.strokeWidth,
      uppercase: spec.uppercase,
      ...(spec.background ? { backgroundColor: spec.background.toUpperCase() } : {}),
    }),
    ...(animationIn ? { animationIn } : {}),
    ...(animationOut ? { animationOut } : {}),
  }
}

const TRANSITIONS = new Set<string>(TransitionType.options)
/** Hard cuts read better on fast transitions; these last a fraction of a beat. */
const SNAPPY = new Set(['flash', 'whip', 'glitch', 'spin', 'zoomin'])

export interface TemplateRefs {
  /** Text presets usable for the hook (generated ones as `trending-live/<id>`). */
  textPresets: readonly string[]
  captionStyles: readonly string[]
}

/** A sound-name hint ("Song — Artist · 118 BPM") users can match when they post. */
export const musicTitle = (
  sound: { title: string; artist?: string | undefined } | undefined,
  bpm: number,
): string =>
  sound
    ? `${sound.title}${sound.artist ? ` — ${sound.artist}` : ''}`
    : `Any track at ~${Math.round(bpm)} BPM`

export const compileTemplate = (
  spec: TemplateSpec,
  cat: Catalogue,
  refs: TemplateRefs,
  id: string,
  trendScore: number,
  sound?: { title: string; artist?: string | undefined; bpm?: number | undefined },
): TemplatePreset => {
  const bpm = editTempo(sound?.bpm ?? spec.bpm)
  const beat = beatsUs(1, bpm)
  const filter = pickRef(spec.filter, cat.filters, undefined)
  const hookPreset = pickRef(spec.hookPreset, refs.textPresets, refs.textPresets[0])
  const captionStyle = pickRef(spec.captionStyle, refs.captionStyles, undefined)
  const durations = spec.slots.map((s) => beatsUs(s.beats, bpm))
  const slots: TemplatePreset['slots'] = spec.slots.map((s, i) => {
    const duration = durations[i]!
    const slot: TemplatePreset['slots'][number] = {
      duration,
      kind: s.kind,
      effects: s.effect && cat.effects.includes(s.effect) ? [s.effect] : [],
      speed: 1,
    }
    if (filter) slot.filter = filter
    if (i > 0 && TRANSITIONS.has(s.transition)) {
      const want = SNAPPY.has(s.transition) ? beat / 4 : beat / 2
      const cap = Math.min(duration, durations[i - 1]!) / 2
      const d = Math.round(Math.max(50_000, Math.min(want, cap, 3_000_000)))
      if (d <= cap) slot.transitionIn = { type: s.transition as TransitionType, duration: d }
    }
    const text = i === 0 ? spec.hookText : s.text
    if (text && hookPreset) slot.text = { text, preset: hookPreset }
    return slot
  })
  return {
    id,
    name: spec.name,
    trendScore,
    tags: tagsOf(spec.tags),
    description: spec.description,
    fps: 30,
    slots,
    ...(captionStyle ? { captionStyle } : {}),
    musicHint: { title: musicTitle(sound, bpm), bpm },
  }
}
