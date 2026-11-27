/** Helpers for the trend engine's data (`GET /api/trends`). */
import type { ReelIdea } from '@/api/schemas.ts'

/**
 * Integration points. `autoEditPath`: route of the Auto Edit flow. "Make this reel" opens
 * it prefilled (`?autoedit=1&topic=<topic>&vibe=<vibe>`, plus the suggested template and
 * first hook); with no path the button opens the suggested template instead.
 */
export const trendsIntegration: { autoEditPath?: string } = { autoEditPath: '/' }

const VIBE_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['talking', /\b(tips?|how to|story|explain|lesson|advice|review|rant|podcast|talk)\b/i],
  ['cinematic', /\b(cinematic|travel|film|epic|drone|sunset|landscape|trailer)\b/i],
  ['aesthetic', /\b(aesthetic|vlog|grwm|routine|outfit|photo ?dump|cozy|soft)\b/i],
  ['fun', /\b(funny|meme|prank|fail|challenge|pov|reaction|comedy|dance)\b/i],
]

/** Auto Edit vibe for a reel idea (keywords in its text; energetic by default). */
export const vibeForIdea = (idea: ReelIdea): string => {
  const text = [idea.topic, idea.title, ...idea.hooks, ...idea.shots].join(' ')
  return VIBE_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'energetic'
}

export const autoEditUrl = (
  idea: ReelIdea,
  templateRef: string | undefined,
): string | undefined => {
  const base = trendsIntegration.autoEditPath
  if (!base) return undefined
  const q = new URLSearchParams({ autoedit: '1', topic: idea.topic, vibe: vibeForIdea(idea) })
  if (templateRef) q.set('template', templateRef)
  if (idea.hooks[0]) q.set('hook', idea.hooks[0])
  return `${base}?${q.toString()}`
}

/** Display names of trend sources. */
export const SOURCE_LABEL: Record<string, string> = {
  'google-trends': 'Google Trends',
  wikipedia: 'Wikipedia',
  'apple-music': 'Apple Music',
  deezer: 'Deezer',
  youtube: 'YouTube',
  reddit: 'Reddit',
  calendar: 'Calendar',
}

export const sourceLabel = (id: string): string => SOURCE_LABEL[id] ?? id

/** Caption + hashtags ready to paste into a post. */
export const postText = (idea: Pick<ReelIdea, 'caption' | 'hashtags'>): string =>
  [idea.caption, idea.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')]
    .filter(Boolean)
    .join('\n\n')
