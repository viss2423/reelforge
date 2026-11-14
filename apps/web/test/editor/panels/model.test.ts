/**
 * Pure model helpers: speed mapping and curves, range algebra, keyframe editing, transcript
 * edits and pack catalogs. `evaluate` (core, still a stub) is replaced by a linear fake.
 */
import {
  CaptionStyle,
  sec,
  type Animatable,
  type Keyframe,
  type Project,
  type Word,
} from '@reelforge/core'
import { describe, expect, it, vi } from 'vitest'
import {
  animationChoices,
  catalog,
  findRef,
  fontFamilies,
  stickerPath,
} from '@/editor/panels/model/catalog.ts'
import {
  clearKeyframes,
  hasKeyframeAt,
  keyframeTime,
  setAnimatable,
  toggleKeyframe,
  valueAt,
} from '@/editor/panels/model/keyframes.ts'
import {
  clipRanges,
  fillerRanges,
  isFiller,
  mergeRanges,
  normalizeWord,
  overlapLength,
} from '@/editor/panels/model/ranges.ts'
import {
  curveRamp,
  detectCurve,
  formatSpeed,
  positionToSpeed,
  SPEED_CURVES,
  SPEED_MAX,
  SPEED_MIN,
  speedToPosition,
} from '@/editor/panels/model/speed.ts'
import {
  applyCaptionStyle,
  deleteWord,
  editWord,
  MIN_WORD,
  mergeWithNext,
  nudgeWord,
  setCaptionStyle,
  splitWord,
  wordIndexAt,
} from '@/editor/panels/model/transcript.ts'
import { makeProject } from '../../fixtures.ts'
import { packsFixture } from './helpers.ts'

vi.mock('@reelforge/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@reelforge/core')>()
  const { fakeCore } = await import('./fakeCore.ts')
  return { ...real, ...fakeCore(real) }
})

/** Exact mean of a ramp over [0, duration] (linear = trapezoid, hold = step). */
const rampMean = (k: readonly Keyframe[], duration: number): number => {
  let area = k[0]!.t * k[0]!.value + (duration - k.at(-1)!.t) * k.at(-1)!.value
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1]!
    const b = k[i]!
    area += b.easing === 'hold' ? (b.t - a.t) * a.value : ((b.t - a.t) * (a.value + b.value)) / 2
  }
  return area / duration
}

describe('speed', () => {
  it('maps the slider log-scale end to end and round-trips', () => {
    expect(positionToSpeed(0)).toBe(SPEED_MIN)
    expect(positionToSpeed(1)).toBe(SPEED_MAX)
    expect(positionToSpeed(-1)).toBe(SPEED_MIN)
    expect(positionToSpeed(speedToPosition(1))).toBe(1)
    expect(positionToSpeed(speedToPosition(2))).toBe(2)
    expect(positionToSpeed(speedToPosition(12.3))).toBe(12.3)
    expect(speedToPosition(100)).toBe(1)
    // 1× sits a bit below the middle (more resolution for slow motion than for 16×).
    expect(speedToPosition(1)).toBeGreaterThan(0.4)
    expect(speedToPosition(1)).toBeLessThan(0.5)
  })

  it('formats speeds like a person would type them', () => {
    expect(formatSpeed(1)).toBe('1×')
    expect(formatSpeed(0.25)).toBe('0.25×')
    expect(formatSpeed(1.5)).toBe('1.5×')
    expect(formatSpeed(12)).toBe('12.0×')
  })

  it.each(SPEED_CURVES.map((c) => [c.id, c] as const))(
    '%s curve keeps duration and source span (mean 1) within 0.1–16×',
    (_id, curve) => {
      for (const speed of [0.5, 1, 4]) {
        const duration = sec(3)
        const k = curveRamp(curve, duration, speed)
        expect(k[0]!.t).toBe(0)
        for (let i = 1; i < k.length; i++) expect(k[i]!.t).toBeGreaterThan(k[i - 1]!.t)
        for (const x of k) {
          expect(Number.isInteger(x.t)).toBe(true)
          expect(x.value * speed).toBeGreaterThanOrEqual(SPEED_MIN - 1e-9)
          expect(x.value * speed).toBeLessThanOrEqual(SPEED_MAX + 1e-9)
        }
        expect(rampMean(k, duration)).toBeLessThanOrEqual(1 + 1e-5)
        expect(rampMean(k, duration)).toBeGreaterThan(0.99)
      }
    },
  )

  it('clamps extreme curves at high base speed without exceeding the source', () => {
    const flash = SPEED_CURVES.find((c) => c.id === 'flashIn')!
    const k = curveRamp(flash, sec(2), 8)
    expect(Math.max(...k.map((x) => x.value * 8))).toBeLessThanOrEqual(SPEED_MAX + 1e-9)
    expect(rampMean(k, sec(2))).toBeLessThanOrEqual(1 + 1e-5)
  })

  it('detects which preset produced a ramp', () => {
    const hero = SPEED_CURVES.find((c) => c.id === 'hero')!
    expect(detectCurve([], sec(2), 1)).toBe('none')
    expect(detectCurve(curveRamp(hero, sec(2), 1), sec(2), 1)).toBe('hero')
    expect(detectCurve([{ t: 0, value: 2, easing: 'linear' }], sec(2), 1)).toBe('custom')
  })
})

describe('ranges', () => {
  it('merges, sorts and drops empty ranges', () => {
    expect(
      mergeRanges([
        { start: 50, end: 60 },
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 30, end: 30 },
        { start: 55, end: 70 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 50, end: 70 },
    ])
    expect(mergeRanges([])).toEqual([])
  })

  it('measures and clips ranges to a window', () => {
    const r = [
      { start: 0, end: 10 },
      { start: 20, end: 40 },
      { start: 50, end: 60 },
    ]
    expect(overlapLength(r, 5, 55)).toBe(5 + 20 + 5)
    expect(overlapLength(r, 60, 100)).toBe(0)
    expect(clipRanges(r, 5, 55)).toEqual([
      { start: 5, end: 10 },
      { start: 20, end: 40 },
      { start: 50, end: 55 },
    ])
  })

  const w = (text: string, start: number, end: number, filler = false): Word => ({
    text,
    start,
    end,
    confidence: 1,
    filler,
    emphasis: false,
  })

  it('recognises fillers by flag or by sound, ignoring punctuation', () => {
    expect(normalizeWord('  Um,')).toBe('um')
    expect(isFiller({ text: 'Uh...', filler: false })).toBe(true)
    expect(isFiller({ text: 'like', filler: true })).toBe(true)
    expect(isFiller({ text: 'umbrella', filler: false })).toBe(false)
  })

  it('pads filler ranges without eating neighbouring words', () => {
    const words = [w('so', 0, 300_000), w('um', 320_000, 500_000), w('yes', 510_000, 800_000)]
    expect(fillerRanges(words)).toEqual([{ start: 300_000, end: 510_000 }])
    // Consecutive fillers merge into one cut; leading filler can pad back to 0.
    const lead = [w('uh', 10_000, 100_000), w('hmm', 100_000, 200_000), w('ok', 400_000, 500_000)]
    expect(fillerRanges(lead)).toEqual([{ start: 0, end: 240_000 }])
    expect(fillerRanges([w('hello', 0, 10)])).toEqual([])
  })
})

describe('keyframes', () => {
  const anim = (value: number, keyframes: Keyframe[] = []): Animatable => ({ value, keyframes })

  it('frame-snaps and clamps keyframe times into the clip', () => {
    const clip = { start: sec(1), duration: sec(2) }
    expect(keyframeTime(clip, sec(1.51), 30)).toBe(500_000)
    expect(keyframeTime(clip, 0, 30)).toBe(0)
    expect(keyframeTime(clip, sec(10), 30)).toBe(sec(2))
    expect(keyframeTime(clip, sec(1) + 40_000, 30)).toBe(33_333)
  })

  it('edits the constant until the property is keyframed, then the keyframe at t', () => {
    const a = anim(1)
    setAnimatable(a, 0, 2, 30)
    expect(a).toEqual({ value: 2, keyframes: [] })
    toggleKeyframe(a, 0, 30)
    toggleKeyframe(a, sec(1), 30)
    expect(a.keyframes.map((k) => [k.t, k.value])).toEqual([
      [0, 2],
      [sec(1), 2],
    ])
    setAnimatable(a, sec(1) + 1000, 5, 30) // within half a frame → same keyframe
    expect(a.keyframes[1]!.value).toBe(5)
    setAnimatable(a, sec(0.5), 3, 30) // between → inserted in order
    expect(a.keyframes.map((k) => k.t)).toEqual([0, sec(0.5), sec(1)])
    expect(hasKeyframeAt(a, sec(0.5), 30)).toBe(true)
  })

  it('toggling adds the current value and removing the last keyframe keeps its value', () => {
    const a = anim(0, [
      { t: 0, value: 0, easing: 'linear' },
      { t: sec(1), value: 10, easing: 'linear' },
    ])
    expect(valueAt(a, sec(0.5))).toBe(5)
    toggleKeyframe(a, sec(0.5), 30)
    expect(a.keyframes[1]).toMatchObject({ t: sec(0.5), value: 5 })
    toggleKeyframe(a, sec(0.5), 30)
    toggleKeyframe(a, 0, 30)
    toggleKeyframe(a, sec(1), 30)
    expect(a).toEqual({ value: 10, keyframes: [] })
  })

  it('clearKeyframes freezes the value shown at the playhead', () => {
    const a = anim(0, [
      { t: 0, value: 0, easing: 'linear' },
      { t: sec(1), value: 10, easing: 'linear' },
    ])
    clearKeyframes(a, sec(0.25))
    expect(a).toEqual({ value: 2.5, keyframes: [] })
  })
})

describe('transcript edits', () => {
  const withWords = (words: Array<[string, number, number]>): Project => {
    const p = makeProject()
    p.captions = {
      enabled: true,
      language: 'en',
      style: CaptionStyle.parse({ base: {}, y: 1500 }),
      words: words.map(([text, start, end]) => ({
        text,
        start,
        end,
        confidence: 0.9,
        filler: false,
        emphasis: false,
      })),
    }
    return p
  }

  it('edits, deletes (also by emptying) and merges words', () => {
    const p = withWords([
      ['gon', 0, 200_000],
      ['na', 200_000, 400_000],
      ['go', 500_000, 700_000],
    ])
    mergeWithNext(p, 0)
    expect(p.captions!.words[0]).toMatchObject({ text: 'gon na', start: 0, end: 400_000 })
    editWord(p, 0, ' gonna ')
    expect(p.captions!.words[0]!.text).toBe('gonna')
    editWord(p, 1, '  ')
    expect(p.captions!.words).toHaveLength(1)
    deleteWord(p, 0)
    expect(p.captions!.words).toHaveLength(0)
    expect(() => deleteWord(p, 0)).toThrow(/No caption word/)
  })

  it('splits proportionally and refuses words that are too short', () => {
    const p = withWords([['hello world', 0, 1_100_000]])
    splitWord(p, 0)
    const [a, b] = p.captions!.words
    expect(a).toMatchObject({ text: 'hello', start: 0, end: 550_000 })
    expect(b).toMatchObject({ text: 'world', start: 550_000, end: 1_100_000 })
    const short = withWords([['ab', 0, MIN_WORD]])
    expect(() => splitWord(short, 0)).toThrow(/too short/)
    expect(() => mergeWithNext(short, 0)).toThrow(/No following word/)
  })

  it('nudges edges within neighbours and a minimum length', () => {
    const p = withWords([
      ['a', 0, 200_000],
      ['b', 300_000, 500_000],
      ['c', 600_000, 800_000],
    ])
    nudgeWord(p, 1, 'start', -500_000)
    expect(p.captions!.words[1]!.start).toBe(200_000)
    nudgeWord(p, 1, 'end', 1_000_000)
    expect(p.captions!.words[1]!.end).toBe(600_000)
    nudgeWord(p, 1, 'start', 1_000_000)
    expect(p.captions!.words[1]!.start).toBe(600_000 - MIN_WORD)
  })

  it('keeps the vertical position when applying a gallery style; patches merge base', () => {
    const p = withWords([['a', 0, 1]])
    applyCaptionStyle(p, CaptionStyle.parse({ base: { fontFamily: 'Anton' }, y: 300 }), 'trend/x')
    expect(p.captions!.style.y).toBe(1500)
    expect(p.captions!.style.base.fontFamily).toBe('Anton')
    expect(p.captions!.styleRef).toBe('trend/x')
    setCaptionStyle(p, { maxWordsPerLine: 5, base: { uppercase: true } })
    expect(p.captions!.style).toMatchObject({
      maxWordsPerLine: 5,
      base: { fontFamily: 'Anton', uppercase: true },
    })
    applyCaptionStyle(p, CaptionStyle.parse({ base: {} }))
    expect(p.captions!.styleRef).toBeUndefined()
    expect(() => setCaptionStyle(makeProject(), {})).toThrow(/Add captions first/)
  })

  it('finds the word under the playhead by binary search', () => {
    const words = withWords([
      ['a', 0, 100],
      ['b', 200, 300],
      ['c', 400, 500],
    ]).captions!.words
    expect(wordIndexAt(words, -1)).toBe(-1)
    expect(wordIndexAt(words, 0)).toBe(0)
    expect(wordIndexAt(words, 250)).toBe(1)
    expect(wordIndexAt(words, 350)).toBe(1)
    expect(wordIndexAt(words, 10_000)).toBe(2)
    expect(wordIndexAt([], 5)).toBe(-1)
  })
})

describe('catalog', () => {
  it('sorts trending first (ties by name), builds refs and thumb paths, memoises', () => {
    const packs = packsFixture()
    const filters = catalog(packs, 'filters')
    expect(filters.map((f) => f.ref)).toEqual(['extra/film', 'trend/warm', 'trend/cold'])
    expect(catalog(packs, 'filters')).toBe(filters)
    const styles = catalog(packs, 'captionStyles')
    expect(styles[0]).toMatchObject({
      ref: 'trend/hormozi',
      thumbPath: 'trend/thumbs/hormozi.webp',
    })
    expect(styles[1]!.thumbPath).toBeUndefined()
    expect(catalog(undefined, 'filters')).toEqual([])
    expect(findRef(packs, 'textPresets', 'trend/plain')?.item.name).toBe('Plain')
    expect(findRef(packs, 'textPresets', undefined)).toBeUndefined()
    expect(stickerPath(catalog(packs, 'stickers')[0]!)).toBe('trend/stickers/fire.webp')
  })

  it('lists font families with their upright weights', () => {
    expect(fontFamilies(packsFixture())).toEqual([
      { family: 'Anton', weights: [400] },
      { family: 'Poppins', weights: [400, 700] },
    ])
    expect(fontFamilies(undefined)).toEqual([])
  })

  it('offers pack animations of the slot first, then builtins', () => {
    const packs = packsFixture()
    const inChoices = animationChoices(packs, 'in')
    expect(inChoices[0]).toMatchObject({ ref: 'trend/swoosh' })
    expect(inChoices.map((c) => c.ref)).toContain('builtin/fade')
    expect(inChoices.map((c) => c.ref)).not.toContain('builtin/pulse')
    const out = animationChoices(packs, 'out')
    expect(out[0]!.ref).toBe('builtin/fade')
    const loop = animationChoices(packs, 'loop').map((c) => c.ref)
    expect(loop).toEqual(['trend/wobble', 'builtin/shake', 'builtin/pulse'])
  })
})
