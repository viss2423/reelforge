/**
 * Just enough XML for RSS/Atom feeds: split `<item>`/`<entry>` blocks and read child text.
 * Feeds are small and flat, so a regex reader is safer than pulling in a full parser (no
 * entity expansion beyond the five predefined entities and numeric references).
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export const decodeXml = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code =
          e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : ''
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .trim()

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every `<tag>…</tag>` block (namespaced tags like `ht:news_item` allowed). */
export const blocks = (xml: string, tag: string): string[] => {
  const re = new RegExp(`<${escapeRe(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(tag)}>`, 'g')
  return [...xml.matchAll(re)].map((m) => m[1] ?? '')
}

/** Decoded text of the first `<tag>` child, or undefined. */
export const child = (xml: string, tag: string): string | undefined => {
  const b = blocks(xml, tag)[0]
  return b === undefined ? undefined : decodeXml(b.replace(/<[^>]+>/g, ' '))
}
