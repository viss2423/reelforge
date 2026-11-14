import { describe, expect, it } from 'vitest'
import {
  Word,
  clipRanges,
  fillerRanges,
  invertRanges,
  isFillerWord,
  mergeRanges,
  normalizeWord,
  silenceToKeepRanges,
} from '../src/index.ts'

const r = (start: number, end: number) => ({ start, end })
const w = (text: string, start: number, end: number, filler = false): Word =>
  Word.parse({ text, start, end, filler })

describe('mergeRanges', () => {
  it('sorts, merges overlapping/touching ranges and drops empty ones', () => {
    expect(mergeRanges([r(5, 8), r(0, 2), r(2, 3), r(7, 10), r(4, 4), r(12, 11)])).toEqual([
      r(0, 3),
      r(5, 10),
    ])
  })

  it('does not mutate its input', () => {
    const input = [r(3, 5), r(0, 4)]
    mergeRanges(input)
    expect(input).toEqual([r(3, 5), r(0, 4)])
  })

  it('handles contained ranges and empty input', () => {
    expect(mergeRanges([r(0, 10), r(2, 3)])).toEqual([r(0, 10)])
    expect(mergeRanges([])).toEqual([])
  })
})

describe('invertRanges / clipRanges', () => {
  it('returns the complement inside the window', () => {
    expect(invertRanges([r(2, 4), r(6, 8)], 0, 10)).toEqual([r(0, 2), r(4, 6), r(8, 10)])
    expect(invertRanges([r(-5, 3), r(9, 20)], 0, 10)).toEqual([r(3, 9)])
    expect(invertRanges([], 0, 10)).toEqual([r(0, 10)])
    expect(invertRanges([r(0, 10)], 0, 10)).toEqual([])
    expect(invertRanges([r(-3, -1), r(12, 14)], 0, 10)).toEqual([r(0, 10)])
  })

  it('clipRanges intersects and merges', () => {
    expect(clipRanges([r(-5, 2), r(1, 4), r(8, 30)], 0, 10)).toEqual([r(0, 4), r(8, 10)])
    expect(clipRanges([r(20, 30)], 0, 10)).toEqual([])
  })
})

describe('filler words', () => {
  it('normalizes punctuation and case', () => {
    expect(normalizeWord('  "Um,"  ')).toBe('um')
    expect(normalizeWord('¿Qué?')).toBe('qué')
    expect(isFillerWord('Uh...')).toBe(true)
    expect(isFillerWord('umbrella')).toBe(false)
  })

  it('fillerRanges covers flagged and recognised fillers with padding bounded by neighbours', () => {
    const words = [
      w('So', 0, 300_000),
      w('um', 400_000, 600_000),
      w('like', 700_000, 900_000, true),
      w('this', 950_000, 1_200_000),
    ]
    // Pad 200 ms: "um" can grow left to the end of "So" (300 ms); "like" to the start of
    // "this" (950 ms). Adjacent fillers merge.
    expect(fillerRanges(words, 200_000)).toEqual([r(300_000, 950_000)])
    expect(fillerRanges(words)).toEqual([r(400_000, 600_000), r(700_000, 900_000)])
  })

  it('pads freely at the edges and never goes negative', () => {
    expect(fillerRanges([w('uh', 50_000, 100_000)], 100_000)).toEqual([r(0, 200_000)])
    expect(fillerRanges([w('real', 0, 10)])).toEqual([])
  })

  it('sorts unsorted words first', () => {
    const words = [w('this', 1_000_000, 1_200_000), w('erm', 500_000, 700_000)]
    expect(fillerRanges(words, 1_000_000)).toEqual([r(0, 1_000_000)])
  })
})

describe('silenceToKeepRanges', () => {
  it('keeps padding next to speech, including at the clip edges', () => {
    const keep = silenceToKeepRanges(
      [r(0, 1_000_000), r(3_000_000, 4_000_000), r(9_000_000, 10_000_000)],
      10_000_000,
      {
        padUs: 100_000,
      },
    )
    expect(keep).toEqual([r(900_000, 3_100_000), r(3_900_000, 9_100_000)])
  })

  it('ignores silences shorter than minSilence and ones swallowed by padding', () => {
    expect(
      silenceToKeepRanges([r(2_000_000, 2_150_000), r(5_000_000, 7_000_000)], 10_000_000, {
        minSilence: 500_000,
      }),
    ).toEqual([r(0, 5_100_000), r(6_900_000, 10_000_000)])
    expect(silenceToKeepRanges([r(2_000_000, 2_150_000)], 10_000_000)).toEqual([r(0, 10_000_000)])
  })

  it('a fully silent clip keeps nothing', () => {
    expect(silenceToKeepRanges([r(0, 5_000_000)], 5_000_000)).toEqual([])
  })
})
