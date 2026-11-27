/**
 * "Ask Magic…": turns a short request ("cut the pauses", "add music") into the Magic tool
 * that does it. Plain keyword matching on the device — nothing is sent anywhere.
 */

/** Magic tool ids (a superset of the AI task ids: some tiles open another panel). */
export type MagicToolId =
  | 'captions'
  | 'silence'
  | 'copy'
  | 'beats'
  | 'reframe'
  | 'removebg'
  | 'voice'
  | 'highlights'
  | 'fillers'
  | 'scenes'
  | 'emphasis'
  | 'magic'

export type AskRoute =
  { kind: 'tool'; id: MagicToolId } | { kind: 'autoedit' } | { kind: 'music' } | { kind: 'unknown' }

/** First match wins, so the specific phrases come before the broad ones. */
const RULES: ReadonlyArray<readonly [RegExp, AskRoute]> = [
  [
    /\b(emoji|emphas|key ?words?|chapters?|improve.*captions?|captions?.*(pop|better))/,
    { kind: 'tool', id: 'emphasis' },
  ],
  [/\b(fillers?|um+s?|uh+s?|erm)\b/, { kind: 'tool', id: 'fillers' }],
  [/\b(silen|pauses?|dead air|gaps?|quiet)/, { kind: 'tool', id: 'silence' }],
  [
    /\b(hooks?|hashtags?|post caption|caption for|write|copy|title)\b/,
    { kind: 'tool', id: 'copy' },
  ],
  [/\b(captions?|subtitles?|subs|transcri)/, { kind: 'tool', id: 'captions' }],
  [/\b(beats?|rhythm|sync)\b/, { kind: 'tool', id: 'beats' }],
  [/\b(music|song|sound ?track|track)\b/, { kind: 'music' }],
  [/\b(reframe|landscape|vertical|9:16|portrait|follow)/, { kind: 'tool', id: 'reframe' }],
  [/\b(background|bg|green ?screen|cut ?out|remove .*behind)/, { kind: 'tool', id: 'removebg' }],
  [/\b(noise|voice|audio|hum|wind|clean)/, { kind: 'tool', id: 'voice' }],
  [/\b(best|highlights?|moments?|shorter|shorten)/, { kind: 'tool', id: 'highlights' }],
  [/\b(scenes?|shots?|split)/, { kind: 'tool', id: 'scenes' }],
  [/\b(quick|one tap|clean ?up|tidy)/, { kind: 'tool', id: 'magic' }],
  [/\b(reel|auto ?edit|edit (it|this|my)|make (it|a|me)|finish)/, { kind: 'autoedit' }],
]

export const routeAsk = (text: string): AskRoute => {
  const q = ` ${text.toLowerCase().replace(/\s+/g, ' ').trim()} `
  if (q.trim() === '') return { kind: 'unknown' }
  for (const [re, route] of RULES) if (re.test(q)) return route
  return { kind: 'unknown' }
}
