/**
 * Timeline layout and interaction constants. Sizes are CSS px; times are integer µs.
 */
import type { TrackKind } from '@reelforge/core'

/** Height of the time ruler (also the scrub zone). */
export const RULER_HEIGHT = 24
/** Content x of timeline time 0, so the first clip's left trim handle stays grabbable. */
export const CONTENT_PAD = 16
/** Space after the last clip, as a fraction of the viewport width. */
export const TAIL_SPACE = 0.5
/** Vertical gap between rows. */
export const ROW_GAP = 4
/** Padding above the first and below the last row. */
export const ROWS_PAD = 4
/** Room below the rows for the header column's add-track button (vertical scroll range). */
export const ADD_TRACK_SPACE = 40

export const MARKER_ROW_HEIGHT = 14
export const CAPTION_ROW_HEIGHT = 24
export const TRACK_ROW_HEIGHT: Readonly<Record<TrackKind, number>> = {
  main: 56,
  overlay: 40,
  text: 30,
  audio: 36,
}

/** Track header column widths. Phones start collapsed (icons only). */
export const HEADER_WIDTH_EXPANDED = 128
export const HEADER_WIDTH_COLLAPSED = 40

/** Clip trim handle: visible bar width and hit slop (each side of the edge). */
export const HANDLE_WIDTH = 12
export const HANDLE_SLOP_MOUSE = 6
export const HANDLE_SLOP_TOUCH = 16

/** Pointer travel before a press becomes a drag. */
export const DRAG_THRESHOLD_MOUSE = 4
export const DRAG_THRESHOLD_TOUCH = 8
/** Touch press duration that lifts a clip for moving / multi-select. */
export const LONG_PRESS_MS = 380

/** Snap distance in px (converted to time with the current zoom). */
export const SNAP_PX_MOUSE = 8
export const SNAP_PX_TOUCH = 14

/** Edge auto-scroll zone width (px) and top speed (px per frame at 60 Hz). */
export const AUTOSCROLL_EDGE = 48
export const AUTOSCROLL_MAX_SPEED = 20

/** Render window overscan on each side, in viewport widths. */
export const OVERSCAN = 1

/** While playing, the playhead is kept at most this far into the viewport (fraction). */
export const FOLLOW_AT = 0.8
/** After a user scroll during playback, auto-follow pauses this long (ms). */
export const FOLLOW_PAUSE_MS = 1500

/** Haptic pulse length (ms) for snaps and long-press lift. */
export const HAPTIC_SNAP = 5
export const HAPTIC_LIFT = 10

/** Touch hold (from press) after which a still finger slips the clip content. */
export const SLIP_PRESS_MS = 900
/** Two fingers: relative distance change that makes the gesture a pinch-zoom. */
export const PINCH_START_RATIO = 0.06
/** Two fingers: midpoint travel (px) at constant distance that starts a box selection. */
export const TWO_FINGER_MARQUEE_PX = 24
