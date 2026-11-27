/**
 * What a template card looks like without a rendered thumbnail: its own hook text in its
 * own text/caption style, over a gradient picked from the template's colours and vibe
 * (keywords in its name, tags and look filter). Pure, so cards stay cheap to render.
 */
import type { TemplatePreset, TextStyle } from '@reelforge/core'
import type { Packs } from '@/api/schemas.ts'

export interface TemplateLook {
  /** The template's opening text, else its name. */
  hook: string
  /** Style of that text (pack text preset, else the caption style's base). */
  style: TextStyle | undefined
  /** CSS `background-image` for the card. */
  background: string
}

/** Keyword → two-stop palette. First match wins; order puts specific moods first. */
const PALETTES: ReadonlyArray<readonly [RegExp, readonly [string, string]]> = [
  [/holiday|christmas|xmas|festive|green/, ['#0b4d3a', '#b3203a']],
  [/winter|snow|ice|frost|cold/, ['#16306e', '#7cc4f5']],
  [/neon|glitch|cyber|vhs|rgb|night/, ['#3b0f7a', '#0ea5c6']],
  [/warm|sunset|golden|film|throwback|retro|vintage|2016|analog|400/, ['#7a2a10', '#e8a33a']],
  [/recipe|food|cook|pasta|kitchen/, ['#8a3412', '#f2b84b']],
  [/cozy|aesthetic|soft|pastel|minimal|calm/, ['#6b2a55', '#e9a6c6']],
  [/tips?|tutorial|how|explain|talk|podcast|alert/, ['#1f2a4d', '#6d5ef0']],
  [/gym|fitness|sport|game|energy|beat|fast|hype/, ['#a3123a', '#f26b1d']],
  [/travel|cinematic|epic|drone|landscape/, ['#0f3b4a', '#d98c3a']],
  [/countdown|day|series|challenge/, ['#2b1f6b', '#ff3d7f']],
]

const FALLBACKS: readonly (readonly [string, string])[] = [
  ['#4c1d95', '#ff2d7a'],
  ['#0f4c5c', '#8b5cf6'],
  ['#7c2d12', '#db2777'],
  ['#1e3a8a', '#14b8a6'],
  ['#3f1d5c', '#f59e0b'],
]

const hash = (s: string): number => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** `#rrggbb(aa)` that is neither near-white nor near-black (usable as a tint). */
const tint = (hex: string | undefined): string | undefined => {
  if (!hex || !/^#[0-9a-f]{6}/i.test(hex)) return undefined
  const n = Number.parseInt(hex.slice(1, 7), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max - min < 40 ? undefined : hex.slice(0, 7)
}

const presetStyle = (packs: Packs | undefined, ref: string | undefined) => {
  if (!packs || !ref) return undefined
  const [packId, id] = ref.split('/')
  const m = packs.manifests.find((p) => p.id === packId)
  return {
    text: m?.textPresets.find((t) => t.id === id)?.style,
    caption: m?.captionStyles.find((c) => c.id === id)?.style,
  }
}

export const templateLook = (
  template: TemplatePreset,
  packs: Packs | undefined,
  trend?: string,
): TemplateLook => {
  const slot = template.slots.find((s) => s.text?.text.trim())
  const textStyle = presetStyle(packs, slot?.text?.preset)?.text
  const caption = presetStyle(packs, template.captionStyle)?.caption
  const style = textStyle ?? caption?.base

  const words = [
    template.name,
    template.description,
    trend ?? '',
    template.captionStyle ?? '',
    ...template.tags,
    ...template.slots.map((s) => s.filter ?? ''),
  ]
    .join(' ')
    .toLowerCase()
  const [a, b] =
    PALETTES.find(([re]) => re.test(words))?.[1] ?? FALLBACKS[hash(template.id) % FALLBACKS.length]!
  // The template's own colours, where it has any, glow over the vibe gradient.
  const accent =
    tint(template.background) ??
    tint(caption?.activeColor) ??
    tint(style?.backgroundColor) ??
    tint(style?.color) ??
    b
  const background = [
    `radial-gradient(80% 55% at 75% 20%, ${accent}cc, transparent 70%)`,
    `radial-gradient(90% 60% at 10% 95%, ${b}aa, transparent 70%)`,
    `linear-gradient(160deg, ${a}, #0b0b10 115%)`,
  ].join(', ')

  return { hook: slot?.text?.text.trim() || template.name, style, background }
}
