import { describe, expect, it } from 'vitest'
import { TextStyle, Word, CaptionStyle } from '../src/index.ts'
import {
  assAlpha,
  assAlphaValue,
  assColor,
  assStyleColor,
  assTime,
  csToAssTime,
  escapeAssText,
  fieldSafe,
  num,
  parseHex,
  toCs,
} from '../src/ass/format.ts'
import { EventSink, bandClip, blurStrength, scaledPassTags } from '../src/ass/events.ts'
import {
  StyleRegistry,
  assAlignment,
  assBold,
  hasBox,
  hasHardShadow,
  hasSoftShadow,
  passAlphas,
} from '../src/ass/styles.ts'
import {
  LINE_BREAK_GAP,
  PAGE_LINGER,
  captionWordText,
  charEm,
  endsSentence,
  fontSpec,
  groupCaptionPages,
  measureText,
  wrapText,
} from '../src/ass/layout.ts'

describe('format', () => {
  it('rounds µs to centiseconds through one function', () => {
    expect(toCs(0)).toBe(0)
    expect(toCs(4_999)).toBe(0)
    expect(toCs(5_000)).toBe(1)
    expect(toCs(1_234_567)).toBe(123)
    expect(toCs(-50_000)).toBe(0)
  })

  it('formats h:mm:ss.cc', () => {
    expect(csToAssTime(0)).toBe('0:00:00.00')
    expect(csToAssTime(6_000 * 61 + 105)).toBe('1:01:01.05')
    expect(assTime(59_990_000)).toBe('0:00:59.99')
    expect(assTime(59_995_000)).toBe('0:01:00.00')
  })

  it('formats compact numbers', () => {
    expect(num(1)).toBe('1')
    expect(num(1.005)).toBe('1')
    expect(num(2.456)).toBe('2.46')
    expect(num(-0.001)).toBe('0')
    expect(num(-3.5)).toBe('-3.5')
  })

  it('converts colours to BGR with inverted alpha', () => {
    expect(parseHex('#11223344')).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 0x44 })
    expect(parseHex('112233')).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 255 })
    expect(assColor('#FF8000')).toBe('&H0080FF&')
    expect(assStyleColor('#FF800080')).toBe('&H7F0080FF')
    expect(assStyleColor('#00000000')).toBe('&HFF000000')
    expect(assAlphaValue(255)).toBe(0)
    expect(assAlphaValue(255, 0.5)).toBe(127)
    expect(assAlphaValue(128, 2)).toBe(127)
    expect(assAlpha(0)).toBe('&H00&')
    expect(assAlpha(300)).toBe('&HFF&')
  })

  it('escapes braces, newlines and escape-forming backslashes', () => {
    expect(escapeAssText('a{b}c')).toBe('a\\{b\\}c')
    expect(escapeAssText('one\ntwo\r\nthree')).toBe('one\\Ntwo\\Nthree')
    expect(escapeAssText('C:\\path')).toBe('C:\\path')
    expect(escapeAssText('\\N')).toBe('\\\u200bN')
    expect(escapeAssText('\\h \\n \\{')).toBe('\\\u200bh \\\u200bn \\\u200b\\{')
    expect(escapeAssText('end\\')).toBe('end\\\u200b')
    expect(fieldSafe('a,b\nc')).toBe('a b c')
  })
})

describe('events', () => {
  it('sorts by start, layer, insertion and drops empty or out-of-window events', () => {
    const sink = new EventSink({ start: 100, end: 500 })
    sink.push({ layer: 2, start: 200, end: 300, style: 'S', text: 'b' })
    sink.push({ layer: 1, start: 200, end: 300, style: 'S', text: 'a' })
    sink.push({ layer: 0, start: 150, end: 160, style: 'S', text: 'first' })
    sink.push({ layer: 0, start: 300, end: 300, style: 'S', text: 'empty' })
    sink.push({ layer: 0, start: 0, end: 100, style: 'S', text: 'before' })
    sink.push({ layer: 0, start: 500, end: 600, style: 'S', text: 'after' })
    expect(sink.size).toBe(3)
    const lines = sink.section().split('\n').slice(2)
    expect(lines.map((l) => l.split(',').at(-1))).toEqual(['first', 'a', 'b'])
  })

  it('clips box bands between lines but not at the block edges', () => {
    expect(bandClip(100, 50, 0, 1)).toBe('\\clip(-1080,-1920,2160,3840)')
    expect(bandClip(100, 50, 0, 2)).toBe('\\clip(-1080,-1920,2160,125)')
    expect(bandClip(150, 50, 1, 2)).toBe('\\clip(-1080,125,2160,3840)')
  })

  it('scales border/shadow/blur with the element scale', () => {
    const style = TextStyle.parse({ strokeWidth: 4, shadowBlur: 10, shadowX: 2, shadowY: 3 })
    expect(scaledPassTags(style, 'main', 1, false)).toBe('')
    expect(scaledPassTags(style, 'main', 1, false, true)).toBe('\\bord4')
    expect(scaledPassTags(style, 'main', 2, true)).toBe('\\bord8\\xshad4\\yshad6')
    expect(scaledPassTags(style, 'shadow', 1, false)).toBe(`\\blur${num(blurStrength(10))}`)
    expect(scaledPassTags(style, 'box', 0.5, false)).toBe('\\bord8')
  })
})

describe('styles', () => {
  it('maps weights, alignment and pass needs', () => {
    expect([assBold(400), assBold(700), assBold(800)]).toEqual([0, -1, 800])
    expect([assAlignment('left'), assAlignment('center'), assAlignment('right')]).toEqual([4, 5, 6])
    const s = TextStyle.parse({})
    expect(hasBox(s)).toBe(false)
    expect(hasBox(TextStyle.parse({ backgroundColor: '#00000000' }))).toBe(false)
    expect(hasBox(TextStyle.parse({ backgroundColor: '#000000' }))).toBe(true)
    expect(hasHardShadow(s)).toBe(true)
    expect(hasSoftShadow(s)).toBe(false)
    expect(hasSoftShadow(TextStyle.parse({ shadowBlur: 4 }))).toBe(true)
    expect(passAlphas(TextStyle.parse({ strokeWidth: 0 }), 'main').outline).toBe(0)
    expect(passAlphas(s, 'box')).toEqual({ fill: 0, outline: 0, shadow: 0 })
  })

  it('de-duplicates styles and names them in first-use order', () => {
    const reg = new StyleRegistry()
    const a = TextStyle.parse({ fontFamily: 'Anton', italic: true, letterSpacing: 2 })
    const b = TextStyle.parse({ fontFamily: 'Inter, Bold' })
    expect(reg.get(a, 'main')).toBe('S1')
    expect(reg.get(b, 'main')).toBe('S2')
    expect(reg.get(a, 'main')).toBe('S1')
    expect(reg.get(a, 'box', '#FF0000')).toBe('S3')
    const section = reg.section()
    expect(section).toContain(
      'Style: S1,Anton,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,800,-1,0,0,100,100,2,0,1,6,0,5,0,0,0,1',
    )
    expect(section).toContain('Style: S2,Inter  Bold,')
    expect(section).toContain(
      'Style: S3,Anton,72,&HFF000000,&HFF000000,&H000000FF,&HFF000000,800,-1,0,0,100,100,2,0,3,16,',
    )
  })
})

describe('layout', () => {
  const font = fontSpec(TextStyle.parse({ fontSize: 100, fontWeight: 400 }))

  it('estimates widths by character class, weight and letter spacing', () => {
    expect(charEm('i')).toBeLessThan(charEm('a'))
    expect(charEm('a')).toBeLessThan(charEm('A'))
    expect(charEm('W')).toBeGreaterThan(charEm('A'))
    expect(charEm('\u0301')).toBe(0)
    expect(charEm('漢')).toBe(1)
    expect(charEm('🔥')).toBe(1)
    expect(charEm('ß')).toBe(0.62)
    expect(measureText('aa', font)).toBeCloseTo(110, 6)
    expect(measureText('aa', { ...font, letterSpacing: 10 })).toBeCloseTo(120, 6)
    expect(measureText('aa', { ...font, weight: 900 })).toBeCloseTo(121, 6)
  })

  it('wraps greedily, keeps explicit newlines and breaks over-long words', () => {
    expect(wrapText('one two three', font, 10_000)).toEqual(['one two three'])
    expect(wrapText('one two three', font, 400)).toEqual(['one two', 'three'])
    expect(wrapText('a\n\nb', font, 400)).toEqual(['a', '', 'b'])
    const long = wrapText('x supercalifragilistic y', font, 300)
    expect(long[0]).toBe('x')
    expect(long.every((l) => measureText(l, font) <= 300)).toBe(true)
    expect(long.join('').replaceAll(' ', '')).toBe('xsupercalifragilisticy')
  })

  it('detects sentence ends and formats caption words', () => {
    expect(endsSentence('done.')).toBe(true)
    expect(endsSentence('what?"')).toBe(true)
    expect(endsSentence('wait…')).toBe(true)
    expect(endsSentence('e.g')).toBe(false)
    const w = Word.parse({ text: 'fire', start: 0, end: 1, emoji: '🔥' })
    expect(captionWordText(w, true)).toBe('FIRE 🔥')
    expect(captionWordText({ ...w, emoji: undefined } as Word, false)).toBe('fire')
  })
})

describe('groupCaptionPages', () => {
  const mk = (spec: Array<[string, number, number]>) =>
    spec.map(([text, start, end]) => Word.parse({ text, start, end }))
  const style = (o: Record<string, unknown> = {}) => CaptionStyle.parse({ base: {}, ...o })
  const lines = (words: Word[], s = style()) =>
    groupCaptionPages(words, s).map((p) =>
      p.lines.map((l) => l.map((i) => words[i]!.text).join(' ')),
    )

  it('packs maxWordsPerLine × maxLines words per page', () => {
    const words = mk(
      Array.from({ length: 7 }, (_, i) => [`w${i}`, i * 200_000, i * 200_000 + 150_000]),
    )
    expect(lines(words)).toEqual([['w0 w1 w2'], ['w3 w4 w5'], ['w6']])
    expect(lines(words, style({ maxWordsPerLine: 2, maxLines: 2 }))).toEqual([
      ['w0 w1', 'w2 w3'],
      ['w4 w5', 'w6'],
    ])
  })

  it('breaks pages on sentence ends and long pauses, lines on short pauses', () => {
    const words = mk([
      ['Hi.', 0, 200_000],
      ['So', 300_000, 400_000],
      ['then', 1_100_000, 1_200_000], // 700 ms pause → new line
      ['we', 3_000_000, 3_100_000], // 1.8 s pause → new page
    ])
    expect(lines(words, style({ maxLines: 3 }))).toEqual([['Hi.'], ['So', 'then'], ['we']])
  })

  it('respects the estimated maxWidth and skips fillers and blanks', () => {
    const words = mk([
      ['Extraordinarily', 0, 100_000],
      ['um', 100_000, 200_000],
      [' ', 200_000, 250_000],
      ['wonderful', 250_000, 300_000],
    ])
    words[1]!.filler = true
    expect(lines(words, style({ base: { maxWidth: 400, fontSize: 72 } }))).toEqual([
      ['Extraordinarily'],
      ['wonderful'],
    ])
  })

  it('extends a page to the next one across short gaps and lingers otherwise', () => {
    const words = mk([
      ['a.', 0, 100_000],
      ['b.', 300_000, 400_000],
      ['c', 2_000_000, 2_100_000],
    ])
    const pages = groupCaptionPages(words, style())
    expect(pages.map((p) => [p.start, p.end])).toEqual([
      [0, 300_000],
      [300_000, 400_000 + PAGE_LINGER],
      [2_000_000, 2_100_000 + PAGE_LINGER],
    ])
    expect(LINE_BREAK_GAP).toBe(600_000)
  })

  it('never lingers past the next page', () => {
    const words = mk([
      ['a.', 0, 100_000],
      ['b', 1_000_000, 1_100_000],
    ])
    const pages = groupCaptionPages(words, style())
    expect(pages[0]!.end).toBe(100_000 + PAGE_LINGER)
    const tight = mk([
      ['a.', 0, 100_000],
      ['b', 750_000, 800_000],
    ])
    expect(groupCaptionPages(tight, style())[0]!.end).toBe(400_000)
  })

  it('handles zero-length words and empty input', () => {
    expect(groupCaptionPages([], style())).toEqual([])
    const pages = groupCaptionPages(mk([['x', 500, 500]]), style())
    expect(pages[0]!.end).toBeGreaterThan(pages[0]!.start)
  })
})
