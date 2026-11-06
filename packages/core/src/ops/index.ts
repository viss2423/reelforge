/**
 * Pure timeline operations. Every mutating op takes a draft Project (Immer draft or plain
 * object) and mutates it in place; ops never perform I/O. Invalid input → OpError.
 * STUB — implemented by the core-engine builder. Signatures are the contract; implementations
 * may be split into sibling files and re-exported from here.
 */
import type {
  Asset,
  AudioClip,
  CaptionStyle,
  Clip,
  MediaClip,
  Project,
  StickerClip,
  TextClip,
  TextStyle,
  Track,
  TrackKind,
  Us,
  Word,
} from '../schema.ts'
import type { PackManifest, TemplatePreset } from '../packs.ts'

export class OpError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'OpError'
  }
}

export interface Range {
  start: Us
  end: Us
}

const todo = (name: string): never => {
  throw new OpError('not_implemented', `${name} not implemented yet`)
}

export function createProject(opts: {
  name: string
  fps?: 24 | 25 | 30 | 50 | 60
  id?: string
  now?: string
}): Project {
  return todo(`createProject(${opts.name})`)
}
export function projectDuration(p: Project): Us {
  return todo(`projectDuration(${p.id})`)
}
export function findClip(
  p: Project,
  clipId: string,
): { track: Track; clip: Clip; index: number } | undefined {
  return todo(`findClip(${p.id},${clipId})`)
}
export function mainTrack(p: Project): Track {
  return todo(`mainTrack(${p.id})`)
}
export function addTrack(
  p: Project,
  kind: TrackKind,
  opts?: { name?: string; index?: number },
): Track {
  return todo(`addTrack(${p.id},${kind},${String(opts)})`)
}
export function removeTrack(p: Project, trackId: string): void {
  todo(`removeTrack(${p.id},${trackId})`)
}
export function insertMediaClip(
  p: Project,
  args: { trackId: string; asset: Asset; at?: Us; index?: number; duration?: Us },
): MediaClip {
  return todo(`insertMediaClip(${p.id},${args.trackId})`)
}
export function insertAudioClip(
  p: Project,
  args: { trackId?: string; asset: Asset; at: Us; role?: AudioClip['role'] },
): AudioClip {
  return todo(`insertAudioClip(${p.id},${args.asset.id})`)
}
export function insertTextClip(
  p: Project,
  args: {
    trackId?: string
    at: Us
    duration?: Us
    text: string
    style?: Partial<TextStyle>
    presetRef?: string
  },
): TextClip {
  return todo(`insertTextClip(${p.id},${args.text})`)
}
export function insertStickerClip(
  p: Project,
  args: { trackId?: string; at: Us; duration?: Us; assetId?: string; ref?: string },
): StickerClip {
  return todo(`insertStickerClip(${p.id},${String(args.at)})`)
}
export function splitClip(p: Project, clipId: string, t: Us): [Clip, Clip] {
  return todo(`splitClip(${p.id},${clipId},${t})`)
}
export function trimClip(p: Project, clipId: string, edges: { start?: Us; end?: Us }): void {
  todo(`trimClip(${p.id},${clipId},${String(edges)})`)
}
export function moveClip(
  p: Project,
  clipId: string,
  to: { trackId?: string; start?: Us; index?: number },
): void {
  todo(`moveClip(${p.id},${clipId},${String(to)})`)
}
export function deleteClips(
  p: Project,
  clipIds: readonly string[],
  opts?: { ripple?: boolean },
): void {
  todo(`deleteClips(${p.id},${clipIds.length},${String(opts)})`)
}
export function duplicateClip(p: Project, clipId: string): Clip {
  return todo(`duplicateClip(${p.id},${clipId})`)
}
export function setClipSpeed(p: Project, clipId: string, speed: number): void {
  todo(`setClipSpeed(${p.id},${clipId},${speed})`)
}
/** Remove ranges given in the asset's SOURCE time from a media/audio clip (silence/filler cuts). */
export function removeSourceRanges(p: Project, clipId: string, ranges: readonly Range[]): void {
  todo(`removeSourceRanges(${p.id},${clipId},${ranges.length})`)
}
/** Build timeline-time captions from per-asset source-time transcripts. */
export function buildCaptions(
  p: Project,
  transcripts: Readonly<Record<string, readonly Word[]>>,
  style: CaptionStyle,
  opts?: { styleRef?: string; language?: string },
): void {
  todo(`buildCaptions(${p.id},${Object.keys(transcripts).length},${style.mode},${String(opts)})`)
}
export function syncToBeats(
  p: Project,
  beats: readonly Us[],
  opts?: { every?: 1 | 2 | 4; trackId?: string },
): void {
  todo(`syncToBeats(${p.id},${beats.length},${String(opts)})`)
}
export function applyTemplate(
  template: TemplatePreset,
  assets: readonly Asset[],
  ctx: { packs: readonly PackManifest[]; name?: string; now?: string },
): Project {
  return todo(`applyTemplate(${template.id},${assets.length},${ctx.packs.length})`)
}
export function applyReframe(
  p: Project,
  clipId: string,
  path: ReadonlyArray<{ t: Us; x: number }>,
): void {
  todo(`applyReframe(${p.id},${clipId},${path.length})`)
}
export function normalizeMainTrack(p: Project): void {
  todo(`normalizeMainTrack(${p.id})`)
}
/** Map timeline time (absolute) → source time for a media/audio clip (respects speed, reverse, ramps). */
export function timelineToSource(clip: MediaClip | AudioClip, t: Us): Us {
  return todo(`timelineToSource(${clip.id},${t})`)
}
/** Map source time → absolute timeline time, or undefined if not visible in the clip. */
export function sourceToTimeline(clip: MediaClip | AudioClip, s: Us): Us | undefined {
  return todo(`sourceToTimeline(${clip.id},${s})`)
}
