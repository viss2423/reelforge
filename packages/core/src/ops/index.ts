/**
 * Pure timeline operations. Every mutating op takes a draft Project (Immer draft or plain
 * object) and mutates it in place; ops never perform I/O. Invalid input → OpError.
 *
 * Invariants maintained by every op (checked by validateProject):
 * - exactly one `main` track, holding only media clips, contiguous from 0 (magnetic);
 * - no overlaps within any other track; every clip at least one frame long;
 * - transitions only on main clips with index > 0, at most half of both neighbours;
 * - main-track timeline arguments are PLAYBACK times (see mainTrackLayout in project.ts).
 */
export { OpError, clone, type Range } from './errors.ts'
export {
  MIN_TRANSITION,
  addTrack,
  createProject,
  defaultTrack,
  effectiveOverlap,
  findClip,
  isFree,
  isMediaClip,
  mainTrack,
  mainTrackLayout,
  minClipDuration,
  placeClip,
  playbackStart,
  projectDuration,
  pruneEmptyTracks,
  removeTrack,
  trackAccepts,
  type MainLayoutEntry,
} from './project.ts'
export {
  clipTimeToSource,
  clipTimeToSourceExact,
  sourceRange,
  sourceSpan,
  sourceToClipTime,
  sourceToClipTimeExact,
  sourceToTimeline,
  speedAt,
  speedProfile,
  timelineToSource,
  type SpeedProfile,
  type TimedClip,
} from './timemap.ts'
export { captionWindows, mainIndexAt, normalizeMainTrack } from './main.ts'
export { sliceKeyframes } from './slice.ts'
export {
  DEFAULT_STILL_DURATION,
  insertAudioClip,
  insertMediaClip,
  insertStickerClip,
  insertTextClip,
} from './insert.ts'
export {
  deleteClips,
  duplicateClip,
  moveClip,
  removeSourceRanges,
  setClipSpeed,
  splitClip,
  trimClip,
} from './edit.ts'
export {
  clipRanges,
  fillerRanges,
  invertRanges,
  isFillerWord,
  mergeRanges,
  normalizeWord,
  silenceToKeepRanges,
} from './ranges.ts'
export { buildCaptions, isKeyword } from './captions.ts'
export { beatGrid, syncToBeats, type BeatSyncOptions } from './beats.ts'
export {
  applyTemplate,
  parseRef,
  resolveAnimationRef,
  resolvePackItem,
  type PackSection,
} from './template.ts'
export { applyReframe, type ReframePoint, type SourceGeometry } from './reframe.ts'
export { rollEdit, rollLimits, slipClip, slipLimits, type AssetDurations } from './slip.ts'
export {
  copyClips,
  moveClips,
  pasteClips,
  type ClipMove,
  type ClipboardData,
  type ClipboardEntry,
} from './clipboard.ts'
export {
  MUSIC_DEFAULT_LENGTH,
  MUSIC_FADE_IN,
  MUSIC_FADE_OUT_MAX,
  insertMusicClip,
  musicCredits,
  reelLength,
  withoutMusic,
  type InsertMusicArgs,
} from './music.ts'
export {
  assembleAutoEdit,
  hasClearDownbeats,
  musicSyncOptions,
  type AutoEditMoment,
  type AutoEditPlan,
  type AutoEditStats,
} from './autoedit.ts'
export { applyCaptionEmphasis, type CaptionMark } from './emphasis.ts'
