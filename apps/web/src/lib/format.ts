import { US_PER_SECOND } from '@reelforge/core'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 1536 → "1.5 KB". Uses 1024 steps (what file managers show). */
export const formatBytes = (bytes: number, digits = 1): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / 1024 ** i
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`
}

/** Microseconds → "0:07" / "1:02:03" (no fractions; for durations on cards). */
export const formatDuration = (us: number): string => {
  const total = Math.max(0, Math.round(us / US_PER_SECOND))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Microseconds remaining → "about 12 s left" style ETA. */
export const formatEta = (us: number | undefined): string => {
  if (us === undefined || !Number.isFinite(us)) return ''
  const s = Math.max(0, Math.round(us / US_PER_SECOND))
  if (s < 60) return `${s}s left`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s left`
  return `${Math.floor(m / 60)}h ${m % 60}m left`
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/** ISO date → "3 minutes ago". */
export const formatRelative = (iso: string, now = Date.now()): string => {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  let v = (t - now) / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit)
    v /= size
  }
  return ''
}
