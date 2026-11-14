/**
 * Built-in text/sticker animations, always available as `builtin/<id>` without any pack.
 * They are plain AnimationPresets so the preview, ASS generator and compiler treat them
 * exactly like pack animations. In-presets end at identity (p = 1); loops start and end at
 * identity so they repeat seamlessly. Any in-preset can also be used as an out-animation
 * (it is played backwards, see presetProgress).
 */
import { AnimationPreset } from './packs.ts'
import type { Easing } from './schema.ts'

type Track = Array<{ t: number; value: number; easing?: Easing }>

interface BuiltinDef {
  id: string
  name: string
  kind: AnimationPreset['kind']
  tags: string[]
  perCharacter?: boolean
  tracks: Partial<Record<keyof AnimationPreset['tracks'], Track>>
}

const fadeIn: Track = [
  { t: 0, value: 0 },
  { t: 1, value: 1, easing: 'easeOut' },
]
const quickFadeIn: Track = [
  { t: 0, value: 0 },
  { t: 0.35, value: 1, easing: 'linear' },
]

const DEFS: readonly BuiltinDef[] = [
  { id: 'fade', name: 'Fade', kind: 'in', tags: ['basic'], tracks: { opacity: fadeIn } },
  {
    id: 'pop',
    name: 'Pop',
    kind: 'in',
    tags: ['trending', 'punchy'],
    tracks: {
      opacity: quickFadeIn,
      scale: [
        { t: 0, value: 0 },
        { t: 0.6, value: 1.15, easing: 'easeOut' },
        { t: 1, value: 1, easing: 'easeInOut' },
      ],
    },
  },
  {
    id: 'slideUp',
    name: 'Slide up',
    kind: 'in',
    tags: ['basic'],
    tracks: {
      opacity: quickFadeIn,
      y: [
        { t: 0, value: 140 },
        { t: 1, value: 0, easing: 'easeOut' },
      ],
    },
  },
  {
    id: 'slideDown',
    name: 'Slide down',
    kind: 'in',
    tags: ['basic'],
    tracks: {
      opacity: quickFadeIn,
      y: [
        { t: 0, value: -140 },
        { t: 1, value: 0, easing: 'easeOut' },
      ],
    },
  },
  {
    id: 'slideLeft',
    name: 'Slide left',
    kind: 'in',
    tags: ['basic'],
    tracks: {
      opacity: quickFadeIn,
      x: [
        { t: 0, value: 220 },
        { t: 1, value: 0, easing: 'easeOut' },
      ],
    },
  },
  {
    id: 'slideRight',
    name: 'Slide right',
    kind: 'in',
    tags: ['basic'],
    tracks: {
      opacity: quickFadeIn,
      x: [
        { t: 0, value: -220 },
        { t: 1, value: 0, easing: 'easeOut' },
      ],
    },
  },
  {
    id: 'zoomIn',
    name: 'Zoom in',
    kind: 'in',
    tags: ['basic'],
    tracks: {
      opacity: fadeIn,
      scale: [
        { t: 0, value: 0.4 },
        { t: 1, value: 1, easing: 'easeOut' },
      ],
    },
  },
  {
    id: 'zoomOut',
    name: 'Zoom out',
    kind: 'in',
    tags: ['basic'],
    tracks: {
      opacity: fadeIn,
      scale: [
        { t: 0, value: 1.8 },
        { t: 1, value: 1, easing: 'easeOut' },
      ],
    },
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    kind: 'in',
    tags: ['trending'],
    perCharacter: true,
    tracks: {
      opacity: [
        { t: 0, value: 0 },
        { t: 1, value: 1, easing: 'hold' },
      ],
    },
  },
  {
    id: 'bounce',
    name: 'Bounce',
    kind: 'in',
    tags: ['trending', 'playful'],
    tracks: {
      opacity: quickFadeIn,
      scale: [
        { t: 0, value: 0.3 },
        { t: 1, value: 1, easing: 'easeOutElastic' },
      ],
    },
  },
  {
    id: 'shake',
    name: 'Shake',
    kind: 'loop',
    tags: ['energetic'],
    tracks: {
      x: [
        { t: 0, value: 0 },
        { t: 0.125, value: -12, easing: 'linear' },
        { t: 0.375, value: 12, easing: 'linear' },
        { t: 0.625, value: -9, easing: 'linear' },
        { t: 0.875, value: 9, easing: 'linear' },
        { t: 1, value: 0, easing: 'linear' },
      ],
      rotation: [
        { t: 0, value: 0 },
        { t: 0.25, value: -2, easing: 'linear' },
        { t: 0.75, value: 2, easing: 'linear' },
        { t: 1, value: 0, easing: 'linear' },
      ],
    },
  },
  {
    id: 'pulse',
    name: 'Pulse',
    kind: 'loop',
    tags: ['subtle'],
    tracks: {
      scale: [
        { t: 0, value: 1 },
        { t: 0.5, value: 1.08, easing: 'easeInOut' },
        { t: 1, value: 1, easing: 'easeInOut' },
      ],
    },
  },
  {
    id: 'spin',
    name: 'Spin',
    kind: 'in',
    tags: ['playful'],
    tracks: {
      opacity: quickFadeIn,
      rotation: [
        { t: 0, value: -270 },
        { t: 1, value: 0, easing: 'easeOutBack' },
      ],
      scale: [
        { t: 0, value: 0 },
        { t: 1, value: 1, easing: 'easeOutBack' },
      ],
    },
  },
  {
    // Softened entrance: libass and the compositor share no blur parameter in AnimatedProps,
    // so "blur in" is rendered as a defocus-style scale settle with a fade.
    id: 'blurIn',
    name: 'Blur in',
    kind: 'in',
    tags: ['cinematic'],
    tracks: {
      opacity: fadeIn,
      scale: [
        { t: 0, value: 1.25 },
        { t: 1, value: 1, easing: 'easeOut' },
      ],
    },
  },
  {
    // A soft left-to-right wipe: characters fade in sequentially.
    id: 'wipe',
    name: 'Wipe',
    kind: 'in',
    tags: ['clean'],
    perCharacter: true,
    tracks: {
      opacity: [
        { t: 0, value: 0 },
        { t: 1, value: 1, easing: 'linear' },
      ],
    },
  },
]

/** All builtin animation presets (ids are bare; refs are `builtin/<id>`). */
export const BUILTIN_ANIMATIONS: readonly AnimationPreset[] = Object.freeze(
  DEFS.map((d) =>
    AnimationPreset.parse({
      id: d.id,
      name: d.name,
      kind: d.kind,
      tags: d.tags,
      trendScore: 50,
      perCharacter: d.perCharacter ?? false,
      tracks: d.tracks,
    }),
  ),
)

/** Prefix of builtin animation refs. */
export const BUILTIN_PREFIX = 'builtin/'

const BY_REF = new Map(BUILTIN_ANIMATIONS.map((a) => [`${BUILTIN_PREFIX}${a.id}`, a]))

/** Resolve `builtin/<id>` to its preset; anything else → undefined. */
export function resolveBuiltinAnimation(ref: string): AnimationPreset | undefined {
  return BY_REF.get(ref)
}
