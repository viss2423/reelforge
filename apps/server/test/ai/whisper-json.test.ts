import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  parseFfmpegSegments,
  parseWhisperFullJson,
  type WhisperFullJson,
  type WhisperToken,
} from '../../src/ai/transcribe/whisper-json.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** Real `whisper-cli -ojf -dtw base` output for a SAPI TTS sentence (ggml-base, v1.9.5). */
const CLI_JSON = JSON.parse(fixture('whisper-cli-base-dtw.json')) as WhisperFullJson

const tok = (text: string, from: number, to: number, p = 0.9, t_dtw = -1): WhisperToken => ({
  text,
  offsets: { from, to },
  p,
  t_dtw,
})

describe('parseWhisperFullJson (real whisper-cli fixture)', () => {
  const r = parseWhisperFullJson(CLI_JSON)

  it('detects language and DTW timing', () => {
    expect(r.language).toBe('en')
    expect(r.dtw).toBe(true)
  })

  it('assembles words, attaching punctuation and merging "$" + "40"', () => {
    expect(r.words.map((w) => w.text)).toEqual([
      'Hello',
      'everyone.',
      'Um,',
      'today',
      'I',
      'will',
      'show',
      'you',
      'three',
      'simple',
      'tricks.',
      'This',
      'camera',
      'costs',
      '$40,',
      'and',
      'it',
      'is',
      'amazing.',
    ])
  })

  it('produces monotonic, non-overlapping microsecond times from DTW ends', () => {
    let prev = 0
    for (const w of r.words) {
      expect(Number.isInteger(w.start) && Number.isInteger(w.end)).toBe(true)
      expect(w.start).toBeGreaterThanOrEqual(prev)
      expect(w.end).toBeGreaterThanOrEqual(w.start)
      prev = w.end
    }
    // "Hello" ends at its DTW time (36 cs); "everyone." ignores the period's DTW time.
    expect(r.words[0]?.end).toBe(360_000)
    expect(r.words[1]?.end).toBe(1_040_000)
    expect(r.words.at(-1)!.end).toBeLessThanOrEqual(9_120_000)
  })

  it('averages lexical token probabilities into confidence', () => {
    expect(r.words[0]?.confidence).toBeCloseTo(0.899311, 5)
    for (const w of r.words) expect(w.confidence).toBeGreaterThan(0)
  })
})

describe('parseWhisperFullJson (synthetic edge cases)', () => {
  it('uses token offsets when DTW is unavailable and merges sub-word tokens', () => {
    const r = parseWhisperFullJson({
      result: { language: 'en' },
      transcription: [
        {
          offsets: { from: 0, to: 2000 },
          tokens: [
            tok('[_BEG_]', 0, 0),
            tok(' Incred', 100, 400, 0.8),
            tok('ible', 400, 700, 0.6),
            tok('!', 700, 720, 0.99),
            tok(' Yes', 900, 1200),
            tok('[_TT_100]', 2000, 2000),
          ],
        },
      ],
    })
    expect(r.dtw).toBe(false)
    expect(r.words).toEqual([
      { text: 'Incredible!', start: 100_000, end: 720_000, confidence: 0.7 },
      { text: 'Yes', start: 900_000, end: 1_200_000, confidence: 0.9 },
    ])
  })

  it('starts a new word at a segment boundary, but not after a hyphen', () => {
    const r = parseWhisperFullJson({
      transcription: [
        { tokens: [tok(' well', 0, 100), tok('-', 100, 110)] },
        { tokens: [tok('known', 200, 300)] },
        { tokens: [tok('next', 400, 500)] },
      ],
    })
    expect(r.words.map((w) => w.text)).toEqual(['well-known', 'next'])
  })

  it('splits space-less scripts into one word per token', () => {
    const r = parseWhisperFullJson({
      result: { language: 'ja' },
      transcription: [
        { tokens: [tok('こんに', 0, 100), tok('ちは', 100, 200), tok('。', 200, 210)] },
      ],
    })
    expect(r.words.map((w) => w.text)).toEqual(['こんに', 'ちは。'])
  })

  it('reassembles UTF-8 sequences split across tokens', () => {
    const r = parseWhisperFullJson({
      transcription: [
        {
          tokens: [
            tok(' caf', 0, 100),
            tok('�', 100, 150),
            tok('é', 150, 200),
            tok(' ok', 300, 400),
          ],
        },
      ],
    })
    expect(r.words.map((w) => w.text)).toEqual(['café', 'ok'])
  })

  it('drops stray punctuation and handles empty input', () => {
    expect(parseWhisperFullJson({ transcription: [{ tokens: [tok(' -', 0, 10)] }] }).words).toEqual(
      [],
    )
    expect(parseWhisperFullJson({})).toEqual({ words: [], dtw: false })
  })

  it('never lets times run backwards', () => {
    const r = parseWhisperFullJson({
      transcription: [{ tokens: [tok(' a', 500, 900, 0.9, 80), tok(' b', 400, 450, 0.9, 60)] }],
    })
    expect(r.words[1]!.start).toBeGreaterThanOrEqual(r.words[0]!.end)
    expect(r.words[1]!.end).toBeGreaterThanOrEqual(r.words[1]!.start)
  })
})

describe('parseFfmpegSegments', () => {
  it('parses the whisper filter JSON lines (real fixture)', () => {
    expect(parseFfmpegSegments(fixture('ffmpeg-whisper-turbo.jsonl'))).toEqual([
      { start: 0, end: 960_000, text: 'Hello everyone.' },
      { start: 1_920_000, end: 4_720_000, text: 'Um, today I will show you three simple tricks.' },
      { start: 5_700_000, end: 8_920_000, text: 'This camera costs $40, and it is amazing.' },
    ])
  })

  it('skips malformed, truncated and empty lines', () => {
    const text = [
      '{"start":0,"end":100,"text":" a "}',
      'garbage',
      '{"start":"x","end":1,"text":"b"}',
      '{"start":200,"end":150,"text":"c"}',
      '{"start":300,"end":400,"text":"   "}',
      '{"start":500,"end":6',
    ].join('\r\n')
    expect(parseFfmpegSegments(text)).toEqual([
      { start: 0, end: 100_000, text: 'a' },
      { start: 200_000, end: 200_000, text: 'c' },
    ])
  })
})
