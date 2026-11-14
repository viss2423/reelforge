/**
 * Font bookkeeping for the libass (JASSUB) text layer: which families an .ass document uses
 * (Style lines and `\fn` overrides), so exactly those font files are loaded BEFORE the
 * track is shown — avoiding the flash of the fallback font that lazy lookup causes.
 */

/** Families referenced by an ASS document (case preserved, de-duplicated, '@' prefix dropped). */
export function assFontFamilies(ass: string): string[] {
  const out = new Map<string, string>()
  const add = (name: string): void => {
    const n = name.trim().replace(/^@/, '')
    if (n && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), n)
  }
  let fontCol = -1
  let inStyles = false
  for (const raw of ass.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inStyles = /^\[v4\+? styles\]$/i.test(line)
      continue
    }
    if (inStyles && /^format:/i.test(line)) {
      fontCol = line
        .slice(7)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .indexOf('fontname')
    } else if (inStyles && /^style:/i.test(line) && fontCol >= 0) {
      const name = line.slice(6).split(',')[fontCol]
      if (name !== undefined) add(name)
    }
  }
  for (const m of ass.matchAll(/\\fn([^\\}]+)/g)) add(m[1]!)
  return [...out.values()]
}

export interface FontFile {
  family: string
  url: string
}

/**
 * URLs of every file of the given families that are not loaded yet (all weights/styles of a
 * family are loaded together — libass picks the face by weight/italic itself).
 */
export function fontUrlsToLoad(
  families: readonly string[],
  fonts: readonly FontFile[],
  loaded: ReadonlySet<string>,
): string[] {
  const want = new Set(families.map((f) => f.toLowerCase()))
  const out: string[] = []
  for (const f of fonts) {
    if (want.has(f.family.toLowerCase()) && !loaded.has(f.url)) out.push(f.url)
  }
  return out
}
