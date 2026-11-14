import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { alignSequences, alignToTimedWords, wordSimilarity } from '../../src/ai/transcribe/align.ts'
import { boundaryThreshold, refineWithLevels } from '../../src/ai/transcribe/refine.ts'
import {
  parseFfmpegSegments,
  parseWhisperFullJson,
  type RawWord,
  type WhisperFullJson,
} from '../../src/ai/transcribe/whisper-json.ts'
import { FRAME_US } from '../../src/ai/silence.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const timed = (spec: string, step = 400_000, conf = 0.9): RawWord[] =>
  spec
    .split(' ')
    .map((text, i) => ({ text, start: i * step, end: i * step + step - 50_000, confidence: conf }))

describe('wordSimilarity', () => {
  it('is 1 for identical words, 0 for empty, and scales with edit distance', () => {
    expect(wordSimilarity('camera', 'camera')).toBe(1)
    expect(wordSimilarity('', 'x')).toBe(0)
    expect(wordSimilarity('color', 'colour')).toBeCloseTo(5 / 6, 6)
    expect(wordSimilarity('abc', 'xyz')).toBe(0)
  })
})

describe('alignSequences', () => {
  it('matches identical sequences one to one', () => {
    expect(Array.from(alignSequences(['a', 'b', 'c'], ['a', 'b', 'c']))).toEqual([0, 1, 2])
  })

  it('skips extra words in the timed window for free at both ends', () => {
    expect(Array.from(alignSequences(['b', 'c'], ['x', 'a', 'b', 'c', 'd']))).toEqual([2, 3])
  })

  it('leaves words missing from the timed transcript unmatched', () => {
    expect(
      Array.from(alignSequences(['the', 'quick', 'brown', 'fox'], ['the', 'brown', 'fox'])),
    ).toEqual([0, -1, 1, 2])
  })

  it('aligns near-miss spellings', () => {
    expect(Array.from(alignSequences(['colour', 'grey'], ['color', 'gray']))).toEqual([0, 1])
  })
})

describe('alignToTimedWords', () => {
  it('transfers DTW timings onto large-model text (real fixtures)', () => {
    const segs = parseFfmpegSegments(fixture('ffmpeg-whisper-turbo.jsonl'))
    const cli = parseWhisperFullJson(
      JSON.parse(fixture('whisper-cli-base-dtw.json')) as WhisperFullJson,
    )
    const out = alignToTimedWords(segs, cli.words)
    expect(out.map((w) => w.text)).toEqual(segs.flatMap((s) => s.text.split(' ')))
    expect(out.every((w) => w.matched)).toBe(true)
    // Identical words take the timed word's times exactly.
    out.forEach((w, i) => {
      expect(w.start).toBe(cli.words[i]?.start)
      expect(w.end).toBe(cli.words[i]?.end)
      expect(w.confidence).toBeGreaterThan(0.5)
    })
  })

  it('interpolates words only the large model heard, inside the gap', () => {
    const out = alignToTimedWords(
      [{ start: 0, end: 2_000_000, text: 'the quick brown fox' }],
      timed('the brown fox'),
    )
    expect(out.map((w) => [w.text, w.matched])).toEqual([
      ['the', true],
      ['quick', false],
      ['brown', true],
      ['fox', true],
    ])
    for (let i = 1; i < out.length; i++)
      expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end - 1)
    expect(out[1]!.confidence).toBeLessThan(0.5)
  })

  it('extends a word over timed words it replaced ("40%" ↔ "40 percent")', () => {
    const out = alignToTimedWords(
      [{ start: 0, end: 2_000_000, text: 'save 40% today' }],
      timed('save 40 percent today'),
    )
    const w40 = out[1]!
    expect(w40.text).toBe('40%')
    expect(w40.end).toBe(1_150_000) // end of "percent"
    expect(out[2]!.start).toBe(1_200_000)
  })

  it('handles segments with no timed counterpart and empty segments', () => {
    const out = alignToTimedWords(
      [
        { start: 0, end: 1_000_000, text: '...' },
        { start: 5_000_000, end: 6_000_000, text: 'hello world' },
      ],
      timed('unrelated'),
    )
    expect(out.map((w) => w.text)).toEqual(['hello', 'world'])
    expect(out[0]!.start).toBeGreaterThanOrEqual(5_000_000)
    expect(out[1]!.end).toBeLessThanOrEqual(6_000_000)
    expect(out[1]!.start).toBeGreaterThanOrEqual(out[0]!.end)
  })

  it('consumes timed words monotonically across segments (repeated phrases)', () => {
    const out = alignToTimedWords(
      [
        { start: 0, end: 900_000, text: 'yes yes' },
        { start: 800_000, end: 1_700_000, text: 'yes yes' },
      ],
      timed('yes yes yes yes'),
    )
    expect(out.map((w) => w.start)).toEqual([0, 400_000, 800_000, 1_200_000])
  })
})

describe('refineWithLevels', () => {
  /** 10 ms levels: speech (-20 dB) in the given [start, end) seconds, silence elsewhere. */
  const levels = (seconds: number, speech: Array<[number, number]>): Float32Array => {
    const out = new Float32Array(Math.round((seconds * 1e6) / FRAME_US)).fill(-90)
    for (const [s, e] of speech)
      out.fill(-20, Math.round((s * 1e6) / FRAME_US), Math.round((e * 1e6) / FRAME_US))
    return out
  }
  const word = (text: string, start: number, end: number, confidence = 0.9): RawWord => ({
    text,
    start,
    end,
    confidence,
  })

  it('moves a word start after a pause onto the speech onset', () => {
    const l = levels(3, [
      [0.2, 0.6],
      [1.5, 2.0],
    ])
    const out = refineWithLevels([word('one', 0, 600_000), word('two', 600_000, 2_000_000)], l)
    expect(out[0]!.start).toBe(200_000)
    expect(out[1]!.start).toBe(1_500_000)
    expect(out[1]!.end).toBe(2_000_000)
  })

  it('trims a word end that runs into silence', () => {
    const out = refineWithLevels([word('hi', 0, 1_500_000)], levels(2, [[0, 0.5]]))
    expect(out[0]!.end).toBe(520_000)
  })

  it('drops low-confidence words placed entirely in silence (hallucinations)', () => {
    const l = levels(4, [[0, 1]])
    const out = refineWithLevels(
      [word('real', 0, 1_000_000), word('Thanks.', 2_500_000, 3_500_000, 0.3)],
      l,
    )
    expect(out.map((w) => w.text)).toEqual(['real'])
    // A confident word in silence is kept (could be a whisper the meter missed).
    expect(refineWithLevels([word('ok', 2_500_000, 3_000_000, 0.95)], l)).toHaveLength(1)
  })

  it('caps implausibly long words', () => {
    const out = refineWithLevels([word('a', 0, 5_000_000)], new Float32Array(500).fill(-20))
    expect(out[0]!.end - out[0]!.start).toBeLessThanOrEqual(400_000 + 90_000)
  })

  it('is a no-op without levels', () => {
    const ws = [word('x', 1, 2)]
    expect(refineWithLevels(ws, new Float32Array(0))).toBe(ws)
  })

  it('derives a boundary threshold 30 dB under speech, bounded at -55 dB', () => {
    expect(boundaryThreshold(new Float32Array(100).fill(-12))).toBe(-42)
    expect(boundaryThreshold(new Float32Array(100).fill(-40))).toBe(-55)
    expect(boundaryThreshold(new Float32Array(100).fill(-100))).toBe(-50)
  })
})
