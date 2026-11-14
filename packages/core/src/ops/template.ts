/** Templates and trend-pack reference resolution. */
import type { Asset, Project, TextAnimation } from '../schema.ts'
import type { AnimationPreset, PackManifest, TemplatePreset } from '../packs.ts'
import { resolveBuiltinAnimation } from '../builtins.ts'
import { newId } from '../ids.ts'
import { clone } from './errors.ts'
import {
  createProject,
  mainTrack,
  mainTrackLayout,
  minClipDuration,
  projectDuration,
} from './project.ts'
import { normalizeMainTrack } from './main.ts'
import { insertAudioClip, insertTextClip, makeMediaClip } from './insert.ts'
import { trimClip } from './edit.ts'

/** Pack sections that hold `<packId>/<itemId>`-addressable items. */
export type PackSection =
  | 'captionStyles'
  | 'textPresets'
  | 'filters'
  | 'animations'
  | 'transitions'
  | 'effects'
  | 'stickers'
  | 'templates'

/** Split `<packId>/<itemId>` (the item id may not contain '/'). */
export function parseRef(ref: string): { packId: string; itemId: string } | undefined {
  const i = ref.indexOf('/')
  if (i <= 0 || i === ref.length - 1 || ref.indexOf('/', i + 1) !== -1) return undefined
  return { packId: ref.slice(0, i), itemId: ref.slice(i + 1) }
}

/** Resolve a `<packId>/<itemId>` ref within one section of the given packs. */
export function resolvePackItem<S extends PackSection>(
  packs: readonly PackManifest[],
  section: S,
  ref: string | undefined,
): PackManifest[S][number] | undefined {
  if (ref === undefined) return undefined
  const parsed = parseRef(ref)
  if (!parsed) return undefined
  const pack = packs.find((pk) => pk.id === parsed.packId)
  const items = pack?.[section] as ReadonlyArray<PackManifest[S][number]> | undefined
  return items?.find((item) => item.id === parsed.itemId)
}

/** Resolve an animation ref against packs, falling back to `builtin/<id>`. */
export function resolveAnimationRef(
  packs: readonly PackManifest[],
  ref: string,
): AnimationPreset | undefined {
  return resolveBuiltinAnimation(ref) ?? resolvePackItem(packs, 'animations', ref)
}

const TEMPLATE_TEXT_ANIMATION_US = 400_000

/**
 * Create a project from a template: slots are filled with the visual assets in order
 * (preferring each slot's kind, reusing assets when there are fewer than slots), with the
 * slot's speed, transition, LUT filter and effects resolved against the packs. Slot texts
 * become text clips spanning their slot, the template caption style becomes the project's
 * caption style, and the first audio asset becomes the music bed (trimmed to the video).
 * Unresolvable pack refs are skipped rather than failing the whole template.
 */
export function applyTemplate(
  template: TemplatePreset,
  assets: readonly Asset[],
  ctx: { packs: readonly PackManifest[]; name?: string; now?: string },
): Project {
  const { packs } = ctx
  const p = createProject({
    name: ctx.name ?? template.name,
    fps: template.fps,
    ...(ctx.now !== undefined && { now: ctx.now }),
  })
  if (template.background) p.settings.background = template.background
  const owner = packs.find((pk) => pk.templates.some((t) => t.id === template.id))
  if (owner) p.templateRef = `${owner.id}/${template.id}`

  const visual = assets.filter((a) => a.kind === 'image' || (a.kind === 'video' && a.duration))
  const used = new Set<number>()
  let recycle = 0
  const pick = (kind: 'video' | 'image' | 'any'): Asset | undefined => {
    if (visual.length === 0) return undefined
    let i = visual.findIndex((a, j) => !used.has(j) && (kind === 'any' || a.kind === kind))
    if (i < 0) i = visual.findIndex((_, j) => !used.has(j))
    if (i < 0) i = recycle++ % visual.length
    used.add(i)
    return visual[i]
  }

  const main = mainTrack(p)
  const min = minClipDuration(p.settings.fps)
  const texts: Array<{ clipIndex: number; text: string; preset: string }> = []
  for (const slot of template.slots) {
    const asset = pick(slot.kind)
    if (!asset) break
    const speed = asset.kind === 'video' ? slot.speed : 1
    const duration =
      asset.kind === 'video'
        ? Math.min(slot.duration, Math.floor(asset.duration! / speed))
        : slot.duration
    if (duration < min) continue
    const clip = makeMediaClip({
      id: newId('c_'),
      type: asset.kind,
      assetId: asset.id,
      start: 0,
      duration,
      speed,
      name: asset.name.slice(0, 200),
    })
    if (slot.transitionIn) clip.transitionIn = { ...slot.transitionIn }
    const filter = resolvePackItem(packs, 'filters', slot.filter)
    if (filter && slot.filter)
      clip.filter = { ref: slot.filter, intensity: filter.defaultIntensity }
    for (const ref of slot.effects) {
      if (resolvePackItem(packs, 'effects', ref)) {
        clip.effects.push({ id: newId('e_'), ref, start: 0, intensity: 1 })
      }
    }
    if (slot.text) texts.push({ clipIndex: main.clips.length, ...slot.text })
    main.clips.push(clip)
  }
  normalizeMainTrack(p)

  const layout = mainTrackLayout(p)
  const animation = (ref: string | undefined): TextAnimation | undefined =>
    ref !== undefined && resolveAnimationRef(packs, ref)
      ? { ref, duration: TEMPLATE_TEXT_ANIMATION_US }
      : undefined
  for (const t of texts) {
    const entry = layout[t.clipIndex]
    if (!entry) continue
    const end = layout[t.clipIndex + 1]?.start ?? entry.end
    const preset = resolvePackItem(packs, 'textPresets', t.preset)
    const clip = insertTextClip(p, {
      at: entry.start,
      duration: Math.max(min, end - entry.start),
      text: t.text,
      ...(preset && { style: preset.style, presetRef: t.preset }),
    })
    const animIn = animation(preset?.animationIn)
    const animOut = animation(preset?.animationOut)
    const animLoop = animation(preset?.animationLoop)
    if (animIn) clip.animationIn = animIn
    if (animOut) clip.animationOut = animOut
    if (animLoop) clip.animationLoop = animLoop
  }

  const captionStyle = resolvePackItem(packs, 'captionStyles', template.captionStyle)
  if (captionStyle && template.captionStyle) {
    p.captions = {
      enabled: true,
      language: 'auto',
      words: [],
      styleRef: template.captionStyle,
      style: clone(captionStyle.style),
    }
  }

  const music = assets.find((a) => a.kind === 'audio' && a.duration)
  const total = projectDuration(p)
  if (music && total >= min) {
    const clip = insertAudioClip(p, { asset: music, at: 0, role: 'music' })
    if (clip.duration > total) trimClip(p, clip.id, { end: total })
  }
  return p
}
