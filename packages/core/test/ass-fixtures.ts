/** Shared fixtures and a structural checker for generated .ass documents. */
import {
  CaptionStyle,
  Word,
  buildAss,
  insertTextClip,
  resolveBuiltinAnimation,
  type Project,
  type TextClip,
} from '../src/index.ts'
import { project } from './helpers.ts'

export const resolve = { resolveAnimation: resolveBuiltinAnimation }

export interface Dialogue {
  layer: number
  start: string
  end: string
  style: string
  text: string
}

const TIME_RE = /^\d+:\d{2}:\d{2}\.\d{2}$/

/** Parse `h:mm:ss.cc` → centiseconds. */
export const cs = (t: string): number => {
  const [h, m, s] = t.split(':') as [string, string, string]
  return Math.round(Number(h) * 360_000 + Number(m) * 6_000 + Number(s) * 100)
}

/** Parse all Dialogue lines (the Text field may contain commas). */
export function dialogues(ass: string): Dialogue[] {
  return ass
    .split('\n')
    .filter((l) => l.startsWith('Dialogue: '))
    .map((l) => {
      const parts = l.slice('Dialogue: '.length).split(',')
      return {
        layer: Number(parts[0]),
        start: parts[1]!,
        end: parts[2]!,
        style: parts[3]!,
        text: parts.slice(9).join(','),
      }
    })
}

/**
 * Structural validation of an ASS document: required sections and headers, every Dialogue
 * has valid times (start < end), a declared style, and balanced override blocks (escaped
 * `\{`/`\}` excluded). Returns a list of problems (empty = valid).
 */
export function checkAss(ass: string): string[] {
  const problems: string[] = []
  for (const needle of [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    'YCbCr Matrix: TV.709',
    '[V4+ Styles]',
    '[Events]',
  ]) {
    if (!ass.includes(needle)) problems.push(`missing ${needle}`)
  }
  const styles = new Set(
    ass
      .split('\n')
      .filter((l) => l.startsWith('Style: '))
      .map((l) => l.slice(7).split(',')[0]!),
  )
  for (const l of ass.split('\n').filter((x) => x.startsWith('Style: '))) {
    if (l.split(',').length !== 23) problems.push(`style has wrong field count: ${l}`)
  }
  for (const d of dialogues(ass)) {
    if (!TIME_RE.test(d.start) || !TIME_RE.test(d.end)) problems.push(`bad time ${d.start}`)
    if (cs(d.end) <= cs(d.start)) problems.push(`empty event ${d.start}-${d.end}`)
    if (!styles.has(d.style)) problems.push(`unknown style ${d.style}`)
    let depth = 0
    for (let i = 0; i < d.text.length; i++) {
      const ch = d.text[i]
      if (ch === '\\' && (d.text[i + 1] === '{' || d.text[i + 1] === '}') && depth === 0) {
        i++
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') depth--
      if (depth < 0 || depth > 1) {
        problems.push(`unbalanced override block: ${d.text}`)
        break
      }
    }
    if (depth !== 0) problems.push(`unclosed override block: ${d.text}`)
    if (d.text.includes('\n') || d.text.includes('\r')) problems.push('raw newline in event')
  }
  return problems
}

/** Visible text of an event (override blocks removed, escapes resolved). */
export const plainText = (text: string): string =>
  text
    .replace(/(?<!\\)\{[^}]*\}/g, '')
    .replace(/\\([{}])/g, '$1')
    .replace(/​/g, '')

/** A project with a single text clip (font family overridable for renderer tests). */
export function textProject(
  clip: Omit<Partial<TextClip>, 'style'> & { style?: Partial<TextClip['style']> } = {},
  family = 'Montserrat',
): { p: Project; clip: TextClip } {
  const p = project()
  const c = insertTextClip(p, {
    at: 0,
    duration: clip.duration ?? 2_000_000,
    text: clip.text ?? 'Hello world',
    style: { fontFamily: family, ...clip.style },
  })
  const { style: _style, text: _text, duration: _duration, ...rest } = clip
  Object.assign(c, rest)
  return { p, clip: c }
}

/** Seven caption words, 300 ms apart, with a keyword and an emoji. */
export function captionWords(): Word[] {
  return ['This', 'is', 'SO', 'cool!', 'Watch', 'this', 'now'].map((text, i) =>
    Word.parse({
      text,
      start: i * 300_000,
      end: i * 300_000 + 250_000,
      emphasis: text === 'SO',
      ...(text === 'cool!' && { emoji: '🔥' }),
    }),
  )
}

/** A project with captions only. */
export function captionProject(
  style: Record<string, unknown> = {},
  family = 'Montserrat',
  words: Word[] = captionWords(),
): Project {
  const p = project()
  const base = (style.base as Record<string, unknown> | undefined) ?? {}
  p.captions = {
    enabled: true,
    language: 'en',
    words,
    style: CaptionStyle.parse({ ...style, base: { fontFamily: family, ...base } }),
  }
  return p
}

export const ass = (p: Project): string => buildAss(p, resolve)
