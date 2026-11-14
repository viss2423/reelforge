/**
 * Editor layout constants shared by the editor shell and the slot components (timeline,
 * tool panels, inspector). See ./README.md for the slot contract.
 */

/**
 * `activePanel` id that opens the media library. On phones it is a bottom sheet; on desktop
 * the library is always visible on the left, so the id only focuses it.
 */
export const MEDIA_PANEL = 'media'

/** Timeline slot height on phones, as a fraction of the viewport height. */
export const MOBILE_TIMELINE_VH = 0.3

/** Fixed widths of the desktop side panes (px). */
export const DESKTOP_LIBRARY_WIDTH = 320
export const DESKTOP_INSPECTOR_WIDTH = 340

/** Desktop timeline slot height (px); the preview takes the remaining height. */
export const DESKTOP_TIMELINE_HEIGHT = 260
