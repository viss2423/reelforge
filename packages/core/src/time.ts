/** Time helpers. All timeline values are integer microseconds. */

export const US_PER_SECOND = 1_000_000
export const US_PER_MS = 1_000

export const sec = (s: number): number => Math.round(s * US_PER_SECOND)
export const ms = (m: number): number => Math.round(m * US_PER_MS)
export const toSeconds = (us: number): number => us / US_PER_SECOND

/** Duration of one frame in microseconds (may be fractional for 30000/1001-type rates). */
export const frameDuration = (fps: number): number => US_PER_SECOND / fps

/** Snap a time to the nearest frame boundary. */
export const snapToFrame = (us: number, fps: number): number => {
  const f = frameDuration(fps)
  return Math.round(Math.round(us / f) * f)
}

export const toFrame = (us: number, fps: number): number => Math.round((us * fps) / US_PER_SECOND)
export const fromFrame = (frame: number, fps: number): number =>
  Math.round((frame * US_PER_SECOND) / fps)

/** "1:02.35" style formatting for UI. */
export const formatTimecode = (us: number, withCentis = true): string => {
  const neg = us < 0
  const total = Math.abs(us)
  const m = Math.floor(total / 60_000_000)
  const s = Math.floor((total % 60_000_000) / US_PER_SECOND)
  const cs = Math.floor((total % US_PER_SECOND) / 10_000)
  const body = `${m}:${String(s).padStart(2, '0')}${withCentis ? `.${String(cs).padStart(2, '0')}` : ''}`
  return neg ? `-${body}` : body
}

/** FFmpeg-friendly seconds string with microsecond precision. */
export const ffTime = (us: number): string => (us / US_PER_SECOND).toFixed(6)
