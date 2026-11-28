/**
 * Display casing for trend text. Search trends arrive lower case ("smu vs lsu"); naive
 * title casing gives "Smu Vs Lsu" and "Don'T". This keeps acronyms, codes and small
 * connector words right, and leaves text that already has real casing alone.
 */

const words = (s: string): Set<string> => new Set(s.trim().split(/\s+/))

/** Common acronyms in trends (sports leagues and teams, agencies, tech). */
const ACRONYMS = words(`
  ai bts byu cbs ceo cia diy espn eu f1 fbi fifa fyp gta hbo icc ipl lsu mlb mls nasa nba
  nbc ncaa nfl nhl nyc ootd psg pov smu tcu ucf ucla uefa ufc uk unlv usa usc wnba wwe
`)

/** Lower case unless first: "SMU vs LSU", "Lord of the Rings", "Día de Muertos". */
const SMALL = words(`
  a an and as at by da de del di du el et for in la le of on or the to und v van von vs
  with y
`)

/** Brand spellings that title casing gets wrong. */
const BRANDS: Record<string, string> = {
  chatgpt: 'ChatGPT',
  iphone: 'iPhone',
  ipad: 'iPad',
  macbook: 'MacBook',
  openai: 'OpenAI',
  playstation: 'PlayStation',
  tiktok: 'TikTok',
  youtube: 'YouTube',
}

const capitalise = (w: string): string =>
  w
    .split('-')
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join('-')

const word = (w: string, first: boolean): string => {
  const bare = w.replace(/[^\p{L}\p{N}]/gu, '')
  if (ACRONYMS.has(bare)) return w.toUpperCase()
  const brand = BRANDS[bare]
  if (brand) return w.replace(bare, brand)
  // Short codes: ps5, gta6, s25, 4k.
  if (/^(?:\p{L}{1,3}\d{1,4}|\d{1,4}k)$/u.test(bare)) return w.toUpperCase()
  if (!first && SMALL.has(bare)) return w
  return capitalise(w)
}

/** "smu vs lsu" → "SMU vs LSU"; "don't stop" → "Don't Stop"; "Taylor Swift" unchanged. */
export const displayTitle = (text: string): string => {
  const t = text.trim().replace(/\s+/g, ' ')
  if (/\p{Lu}/u.test(t)) return t
  return t
    .split(' ')
    .map((w, i) => word(w, i === 0))
    .join(' ')
}
