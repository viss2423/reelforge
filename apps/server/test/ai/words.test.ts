import type { Word } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import {
  markEmphasis,
  markFillers,
  normalizeWord,
  sanitizeTimings,
} from '../../src/ai/transcribe/words.ts'

/** Words from a sentence, 300 ms apart. */
const words = (sentence: string): Word[] =>
  sentence.split(' ').map((text, i) => ({
    text,
    start: i * 300_000,
    end: i * 300_000 + 250_000,
    confidence: 0.9,
    filler: false,
    emphasis: false,
  }))

const flagged = (ws: Word[], key: 'filler' | 'emphasis'): string[] =>
  ws.filter((w) => w[key]).map((w) => w.text)

describe('normalizeWord', () => {
  it('lower-cases and strips surrounding punctuation only', () => {
    expect(normalizeWord(' Um, ')).toBe('um')
    expect(normalizeWord('"Don\'t!"')).toBe("don't")
    expect(normalizeWord('$40,')).toBe('40')
    expect(normalizeWord('...')).toBe('')
  })
})

describe('markFillers', () => {
  it('flags English hesitations regardless of case and punctuation', () => {
    const ws = words('Um, so I was, uh, thinking. Hmm... Erm OK')
    expect(markFillers(ws, { language: 'en' })).toBe(4)
    expect(flagged(ws, 'filler')).toEqual(['Um,', 'uh,', 'Hmm...', 'Erm'])
  })

  it('is conservative: meaningful interjections are kept', () => {
    const ws = words('Like, so, well, oh mhm yeah right')
    expect(markFillers(ws, { language: 'en' })).toBe(0)
  })

  it('flags "you know" / "I mean" only as parentheticals', () => {
    const a = words('It was, you know, really hard.')
    markFillers(a, { language: 'en' })
    expect(flagged(a, 'filler')).toEqual(['you', 'know,'])

    const b = words('Do you know him? I mean it.')
    markFillers(b, { language: 'en' })
    expect(flagged(b, 'filler')).toEqual([])

    const c = words('I mean, it works.')
    markFillers(c, { language: 'en' })
    expect(flagged(c, 'filler')).toEqual(['I', 'mean,'])

    const d = words('That is great, you know')
    markFillers(d, { language: 'en' })
    expect(flagged(d, 'filler')).toEqual(['you', 'know'])
  })

  it('uses per-language lists and a universal fallback', () => {
    const de = words('Also äh ich ähm weiß nicht')
    markFillers(de, { language: 'de' })
    expect(flagged(de, 'filler')).toEqual(['äh', 'ähm'])

    const fr = words('Alors euh voilà')
    markFillers(fr, { language: 'fr-FR' })
    expect(flagged(fr, 'filler')).toEqual(['euh'])

    // "er" is an English filler but not in the universal list (it is a real word in German).
    const unknown = words('um er uh')
    markFillers(unknown, { language: 'auto' })
    expect(flagged(unknown, 'filler')).toEqual(['um', 'uh'])

    const sw = words('um sawa')
    markFillers(sw, { language: 'sw' })
    expect(flagged(sw, 'filler')).toEqual(['um'])
  })

  it('accepts user-defined words and phrases', () => {
    const ws = words('So basically it is kind of like magic')
    markFillers(ws, { language: 'en', extra: ['Basically', 'kind of'] })
    expect(flagged(ws, 'filler')).toEqual(['basically', 'kind', 'of'])
  })

  it('does not double count', () => {
    const ws = words('um um')
    expect(markFillers(ws, { language: 'en', extra: ['um'] })).toBe(2)
  })
})

describe('markEmphasis', () => {
  it('emphasises numbers, money, percentages, shouting and exclamations', () => {
    const ws = words('I made $5,000 in 3 days, 40% more, a MILLION dollars! It is OK I guess')
    markEmphasis(ws)
    expect(flagged(ws, 'emphasis')).toEqual(['$5,000', '3', '40%', 'MILLION', 'dollars!', 'OK'])
  })

  it('handles currency suffixes, number words and single capitals', () => {
    const ws = words('costs 20€ about two thousand euros I A')
    markEmphasis(ws)
    expect(flagged(ws, 'emphasis')).toEqual(['20€', 'thousand', 'euros'])
  })

  it('never emphasises fillers or uncased scripts', () => {
    const ws = words('UM 你好 Hello')
    ws[0]!.filler = true
    expect(markEmphasis(ws)).toBe(0)
  })
})

describe('sanitizeTimings', () => {
  const w = (text: string, start: number, end: number): Word => ({
    text,
    start,
    end,
    confidence: 1,
    filler: false,
    emphasis: false,
  })

  it('sorts, removes overlaps and keeps times integral', () => {
    const out = sanitizeTimings(
      [w('b', 1_000_000.4, 1_500_000), w('a', 0, 1_200_000), w('c', 1_400_000, 2_000_000)],
      3_000_000,
    )
    expect(out.map((x) => [x.text, x.start, x.end])).toEqual([
      ['a', 0, 1_200_000],
      ['b', 1_200_000, 1_500_000],
      ['c', 1_500_000, 2_000_000],
    ])
  })

  it('clamps to the media duration and gives zero-length words a minimal duration', () => {
    const out = sanitizeTimings(
      [w('a', -5, 100), w('b', 500_000, 500_000), w('c', 2_900_000, 4_000_000)],
      3_000_000,
    )
    expect(out.map((x) => [x.start, x.end])).toEqual([
      [0, 100],
      [500_000, 520_000],
      [2_900_000, 3_000_000],
    ])
  })

  it('drops words that cannot get a positive duration', () => {
    const out = sanitizeTimings(
      [w('a', 0, 1_000_000), w('b', 1_000_000, 1_000_000), w('c', 1_000_000, 1_000_000)],
      1_000_000,
    )
    expect(out.map((x) => x.text)).toEqual(['a'])
    for (const x of out) expect(x.end).toBeGreaterThan(x.start)
  })

  it('returns a new array and leaves input untouched', () => {
    const input = [w('a', 10, 5)]
    const out = sanitizeTimings(input, 1_000)
    expect(input[0]!.end).toBe(5)
    expect(out[0]!.end).toBeGreaterThan(out[0]!.start)
  })
})
