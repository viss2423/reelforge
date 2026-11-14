/**
 * Read-only views over the synced trend packs for the galleries: every item gets its
 * `<packId>/<itemId>` ref and a resolvable thumbnail path, and lists are sorted most
 * trending first (ties by name) — the order the owner's audience expects.
 * Results are memoised per `Packs` object (the query cache keeps it referentially stable).
 */
import type {
  AnimationPreset,
  CaptionStylePreset,
  EffectPreset,
  FilterPreset,
  PackManifest,
  StickerPreset,
  TextPreset,
  TransitionPreset,
} from '@reelforge/core'
import { BUILTIN_ANIMATIONS } from '@reelforge/core'
import type { Packs } from '@/api/schemas.ts'

export interface CatalogItem<T> {
  /** `<packId>/<itemId>` */
  ref: string
  packId: string
  item: T
  /** Pack-relative path for `api.packFileUrl`, when the item ships a thumbnail. */
  thumbPath?: string
}

type Section =
  | 'captionStyles'
  | 'textPresets'
  | 'filters'
  | 'animations'
  | 'transitions'
  | 'effects'
  | 'stickers'

interface SectionItem {
  captionStyles: CaptionStylePreset
  textPresets: TextPreset
  filters: FilterPreset
  animations: AnimationPreset
  transitions: TransitionPreset
  effects: EffectPreset
  stickers: StickerPreset
}

const cache = new WeakMap<Packs, Map<Section, CatalogItem<unknown>[]>>()

const build = <S extends Section>(manifests: readonly PackManifest[], section: S) => {
  const out: CatalogItem<SectionItem[S]>[] = []
  for (const m of manifests) {
    for (const item of m[section] as SectionItem[S][]) {
      out.push({
        ref: `${m.id}/${item.id}`,
        packId: m.id,
        item,
        ...(item.thumb ? { thumbPath: `${m.id}/${item.thumb}` } : {}),
      })
    }
  }
  return out.sort(
    (a, b) => b.item.trendScore - a.item.trendScore || a.item.name.localeCompare(b.item.name),
  )
}

/** All items of one pack section across packs, most trending first. */
export const catalog = <S extends Section>(
  packs: Packs | undefined,
  section: S,
): readonly CatalogItem<SectionItem[S]>[] => {
  if (!packs) return []
  let bySection = cache.get(packs)
  if (!bySection) {
    bySection = new Map()
    cache.set(packs, bySection)
  }
  let list = bySection.get(section)
  if (!list) {
    list = build(packs.manifests, section)
    bySection.set(section, list)
  }
  return list as CatalogItem<SectionItem[S]>[]
}

/** Finds a catalog item by ref. */
export const findRef = <S extends Section>(
  packs: Packs | undefined,
  section: S,
  ref: string | undefined,
): CatalogItem<SectionItem[S]> | undefined =>
  ref ? catalog(packs, section).find((c) => c.ref === ref) : undefined

/** Pack-relative path of a sticker image. */
export const stickerPath = (entry: CatalogItem<StickerPreset>): string =>
  `${entry.packId}/${entry.item.file}`

/** Font families shipped in packs (sorted), with the weights available for each. */
export const fontFamilies = (packs: Packs | undefined): { family: string; weights: number[] }[] =>
  (packs?.index.fonts ?? [])
    .map((f) => ({
      family: f.family,
      weights: [...new Set(f.files.filter((x) => !x.italic).map((x) => x.weight))].sort(
        (a, b) => a - b,
      ),
    }))
    .sort((a, b) => a.family.localeCompare(b.family))

/* ------------------------------------------------------------------ animations */

export type AnimationSlot = 'in' | 'out' | 'loop'

export interface AnimationChoice {
  ref: string
  name: string
  thumbPath?: string
  trendScore: number
}

/**
 * Animations offered for a slot: pack animations of that kind (trending first), then core's
 * builtins (`builtin/<id>`). Out-slots also offer builtin in-animations, which core plays in
 * reverse.
 */
export const animationChoices = (
  packs: Packs | undefined,
  slot: AnimationSlot,
): AnimationChoice[] => {
  const fromPacks: AnimationChoice[] = catalog(packs, 'animations')
    .filter((a) => a.item.kind === slot)
    .map((a) => ({
      ref: a.ref,
      name: a.item.name,
      trendScore: a.item.trendScore,
      ...(a.thumbPath ? { thumbPath: a.thumbPath } : {}),
    }))
  const builtinKind = slot === 'loop' ? 'loop' : 'in'
  const builtins = BUILTIN_ANIMATIONS.filter((b) => b.kind === builtinKind).map((b) => ({
    ref: `builtin/${b.id}`,
    name: b.name,
    trendScore: 0,
  }))
  return [...fromPacks, ...builtins]
}
