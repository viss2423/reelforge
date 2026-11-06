/**
 * Trend packs — versioned, auto-updating content bundles (caption styles, text presets,
 * templates, LUT filters, transitions presets, effects, animations, stickers, fonts).
 *
 * Layout in the repo (and in the server's local pack cache):
 *   packs/index.json                       -> PackIndex
 *   packs/<packId>/pack.json               -> PackManifest
 *   packs/<packId>/luts/<id>.cube          -> 3D LUT files referenced by filters
 *   packs/<packId>/stickers/<id>.(png|webp|svg)
 *   packs/<packId>/thumbs/<id>.webp        -> optional preview thumbnails
 *   packs/fonts/<Family>/<file>.ttf        -> OFL fonts (shared by all packs)
 *
 * The server polls `index.json` from the GitHub repo, downloads packs whose `version`
 * changed, verifies sha256 of every file, validates with these schemas and swaps the
 * new copy in atomically. Refs everywhere are `<packId>/<itemId>`.
 */
import { z } from 'zod'
import { CaptionStyle, Easing, HexColor, Id, TextStyle, TransitionType, Us } from './schema.ts'

export const PackFile = z.object({
  path: z.string(), // relative to the pack dir (or to packs/ for fonts)
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
})
export type PackFile = z.infer<typeof PackFile>

export const PackIndexEntry = z.object({
  id: Id,
  version: z.string(), // semver
  name: z.string(),
  description: z.string().default(''),
  /** ISO date the trends in this pack were curated. */
  curatedAt: z.string(),
  tags: z.array(z.string()).default([]),
})

export const PackIndex = z.object({
  /** Bumped on every publish; clients compare this to decide whether to sync. */
  version: z.string(),
  updatedAt: z.string(),
  minAppVersion: z.string().default('0.1.0'),
  packs: z.array(PackIndexEntry),
  fonts: z.array(
    z.object({
      family: z.string(),
      license: z.string().default('OFL-1.1'),
      files: z.array(
        PackFile.extend({ weight: z.number().int(), italic: z.boolean().default(false) }),
      ),
    }),
  ),
})
export type PackIndex = z.infer<typeof PackIndex>

const PackItemBase = z.object({
  id: Id,
  name: z.string(),
  /** Higher = more trending right now; UI sorts by this. */
  trendScore: z.number().min(0).max(100).default(50),
  tags: z.array(z.string()).default([]),
  thumb: z.string().optional(),
})

export const CaptionStylePreset = PackItemBase.extend({ style: CaptionStyle })
export const TextPreset = PackItemBase.extend({
  style: TextStyle,
  animationIn: z.string().optional(),
  animationOut: z.string().optional(),
  animationLoop: z.string().optional(),
  sampleText: z.string().default('Your text'),
})
export const FilterPreset = PackItemBase.extend({
  /** Path to a .cube 3D LUT relative to pack dir. */
  lut: z.string(),
  defaultIntensity: z.number().min(0).max(1).default(1),
})

/**
 * Text/sticker animation described as keyframed properties so the web preview, the ASS
 * generator and the FFmpeg compiler can all implement it from the same data.
 * `t` is normalised 0..1 across the animation duration.
 */
export const AnimationPreset = PackItemBase.extend({
  kind: z.enum(['in', 'out', 'loop']),
  tracks: z.object({
    opacity: z
      .array(
        z.object({
          t: z.number().min(0).max(1),
          value: z.number(),
          easing: Easing.default('easeOut'),
        }),
      )
      .optional(),
    scale: z
      .array(
        z.object({
          t: z.number().min(0).max(1),
          value: z.number(),
          easing: Easing.default('easeOut'),
        }),
      )
      .optional(),
    x: z
      .array(
        z.object({
          t: z.number().min(0).max(1),
          value: z.number(),
          easing: Easing.default('easeOut'),
        }),
      )
      .optional(),
    y: z
      .array(
        z.object({
          t: z.number().min(0).max(1),
          value: z.number(),
          easing: Easing.default('easeOut'),
        }),
      )
      .optional(),
    rotation: z
      .array(
        z.object({
          t: z.number().min(0).max(1),
          value: z.number(),
          easing: Easing.default('easeOut'),
        }),
      )
      .optional(),
  }),
  /** Character-level reveal (typewriter) */
  perCharacter: z.boolean().default(false),
})

export const TransitionPreset = PackItemBase.extend({
  type: TransitionType,
  duration: Us.default(400_000),
})

/** Effects are implemented natively in core (compiler + preview); packs parameterise them. */
export const EffectPreset = PackItemBase.extend({
  effect: z.enum([
    'shake',
    'zoomPulse',
    'rgbSplit',
    'flash',
    'blurIn',
    'vhs',
    'glow',
    'beatZoom',
    'strobe',
    'filmGrain',
  ]),
  params: z.record(z.string(), z.number()).default({}),
})

export const StickerPreset = PackItemBase.extend({
  file: z.string(),
  width: z.number().int(),
  height: z.number().int(),
})

/**
 * Template: a reel skeleton. Slots are filled with the user's media in order; cut points
 * are usually beat-synced to the template's music suggestion.
 */
export const TemplatePreset = PackItemBase.extend({
  description: z.string().default(''),
  fps: z
    .union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)])
    .default(30),
  slots: z.array(
    z.object({
      duration: Us,
      kind: z.enum(['video', 'image', 'any']).default('any'),
      transitionIn: z.object({ type: TransitionType, duration: Us }).optional(),
      effects: z.array(z.string()).default([]),
      filter: z.string().optional(),
      speed: z.number().min(0.1).max(16).default(1),
      text: z.object({ text: z.string(), preset: z.string() }).optional(),
    }),
  ),
  captionStyle: z.string().optional(),
  /** Free-text music suggestion (trending sound name / BPM); no copyrighted audio is shipped. */
  musicHint: z
    .object({ title: z.string(), bpm: z.number().optional(), url: z.string().optional() })
    .optional(),
  background: HexColor.optional(),
})

export const PackManifest = z.object({
  id: Id,
  version: z.string(),
  name: z.string(),
  description: z.string().default(''),
  author: z.string().default('ReelForge community'),
  license: z.string().default('CC0-1.0'),
  curatedAt: z.string(),
  files: z.array(PackFile).default([]),
  captionStyles: z.array(CaptionStylePreset).default([]),
  textPresets: z.array(TextPreset).default([]),
  filters: z.array(FilterPreset).default([]),
  animations: z.array(AnimationPreset).default([]),
  transitions: z.array(TransitionPreset).default([]),
  effects: z.array(EffectPreset).default([]),
  stickers: z.array(StickerPreset).default([]),
  templates: z.array(TemplatePreset).default([]),
})
export type PackManifest = z.infer<typeof PackManifest>
export type CaptionStylePreset = z.infer<typeof CaptionStylePreset>
export type TextPreset = z.infer<typeof TextPreset>
export type FilterPreset = z.infer<typeof FilterPreset>
export type AnimationPreset = z.infer<typeof AnimationPreset>
export type TransitionPreset = z.infer<typeof TransitionPreset>
export type EffectPreset = z.infer<typeof EffectPreset>
export type StickerPreset = z.infer<typeof StickerPreset>
export type TemplatePreset = z.infer<typeof TemplatePreset>
