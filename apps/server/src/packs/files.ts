/**
 * Path safety for pack content. Pack ids and file paths come from the network (index.json /
 * pack.json) and from request URLs, so every segment is validated before touching the disk.
 */
import path from 'node:path'

const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** One path segment: no separators, no leading dot (blocks "." / ".." / hidden files). */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9 ._()+,-]{0,127}$/
/** Windows device names resolve to devices, not files, in any directory and with any extension. */
const WIN_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i

export const isSafePackId = (id: string): boolean =>
  PACK_ID.test(id) && !id.includes('..') && !WIN_DEVICE.test(id)

/** Validates a relative, forward-slash pack path and returns its segments (undefined if unsafe). */
export const safeSegments = (rel: string): string[] | undefined => {
  if (rel.length === 0 || rel.length > 512 || rel.includes('\\') || rel.includes('\0'))
    return undefined
  const parts = rel.split('/')
  for (const p of parts)
    if (!SEGMENT.test(p) || WIN_DEVICE.test(p) || p.endsWith('.') || p.endsWith(' '))
      return undefined
  return parts
}

/** Resolves `rel` inside `root`; undefined when it is unsafe or escapes the root. */
export const resolveInside = (root: string, rel: string): string | undefined => {
  const parts = safeSegments(rel)
  if (!parts) return undefined
  const full = path.resolve(root, ...parts)
  const base = path.resolve(root)
  return full.startsWith(base + path.sep) ? full : undefined
}

/** `rel` with every segment URI-encoded (for download URLs). */
export const encodePath = (rel: string): string => rel.split('/').map(encodeURIComponent).join('/')

/** Compares dotted numeric versions ("1.10.0" > "1.9.3"); non-numeric parts compare as 0. */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}
