/**
 * FFmpeg filtergraph escaping.
 *
 * A filtergraph description is unescaped twice (see "Notes on filtergraph escaping" in the
 * FFmpeg filters documentation):
 *  - graph level: the graph parser splits filters/chains on `[ ] , ;` and strips one level
 *    of quoting/backslashes;
 *  - option level: each filter splits its argument string into `key=value` pairs on `:` and
 *    strips another level.
 *
 * Inside single quotes everything is literal (including backslashes), so the most robust
 * encoding is: backslash-escape the option-level specials (`\ ' :`), then wrap the result in
 * single quotes for the graph level, splicing any literal `'` as `'\''` (POSIX-shell style).
 */
import { num } from './expr.ts'

const OPTION_SPECIAL = /[\\':]/g
const NEEDS_QUOTING = /[\\':,;[\]\s=]/

/** Escape a value for use as a filter option value inside a filtergraph description. */
export function escapeOptionValue(value: string): string {
  if (value === '') return "''"
  if (!NEEDS_QUOTING.test(value)) return value
  const optionEscaped = value.replace(OPTION_SPECIAL, (c) => `\\${c}`)
  return `'${optionEscaped.replaceAll("'", "'\\''")}'`
}

/**
 * Escape a filesystem path for a filter option (e.g. `ass=filename=…`, `lut3d=file=…`).
 * Backslashes are normalised to forward slashes first (Windows accepts both), which keeps
 * graphs readable; the drive colon and any quote/bracket/comma characters are escaped.
 */
export function escapeFilterPath(path: string): string {
  return escapeOptionValue(path.replaceAll('\\', '/'))
}

/** Option values accepted by {@link filter}. `undefined`/`false` options are omitted. */
export type FilterOptionValue = string | number | boolean | undefined

/** Build `name=k1=v1:k2=v2` with every value escaped; `true` becomes `1`. */
export function filter(
  name: string,
  options: Readonly<Record<string, FilterOptionValue>> = {},
): string {
  const parts: string[] = []
  for (const [key, raw] of Object.entries(options)) {
    if (raw === undefined || raw === false) continue
    const value = raw === true ? '1' : typeof raw === 'number' ? num(raw) : raw
    parts.push(`${key}=${escapeOptionValue(value)}`)
  }
  return parts.length > 0 ? `${name}=${parts.join(':')}` : name
}
