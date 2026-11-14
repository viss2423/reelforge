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
export { syncToBeats } from './beats.ts'
export {
  applyTemplate,
  parseRef,
  resolveAnimationRef,
  resolvePackItem,
  type PackSection,
} from './template.ts'
export { applyReframe, type SourceGeometry } from './reframe.ts'
