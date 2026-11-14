import { describe, expect, it } from 'vitest'
import {
  Word,
  addTrack,
  buildCaptions,
  deleteClips,
  insertAudioClip,
  insertMediaClip,
  isKeyword,
  mainTrack,
  moveClip,
  setClipSpeed,
  splitClip,
  trimClip,
  validateProject,
} from '../src/index.ts'
import { asset, captionStyle, project, projectWithMain, words } from './helpers.ts'

const SEC = 1_000_000
const w = (text: string, start: number, end: number, extra: Partial<Word> = {}): Word =>
  Word.parse({ text, start, end, ...extra })
const spans = (p: { captions?: { words: Word[] } }) =>
  p.captions!.words.map((x) => [x.text, x.start, x.end])
const plain = captionStyle({ emphasizeKeywords: false })

describe('isKeyword', () => {
  it('detects numbers, shouting, exclamations and power words', () => {
    expect(isKeyword('$100')).toBe(true)
    expect(isKeyword('50%')).toBe(true)
    expect(isKeyword('STOP')).toBe(true)
    expect(isKeyword('wow!')).toBe(true)
    expect(isKeyword('Secret,')).toBe(true)
    expect(isKeyword('hello')).toBe(false)
    expect(isKeyword('I')).toBe(false)
  })
})

describe('buildCaptions', () => {
  it('maps words through a single clip and sets style metadata', () => {
    const { p, clips } = projectWithMain([5 * SEC])
    const style = captionStyle({ mode: 'pop' })
    buildCaptions(
      p,
      { [clips[0]!.assetId]: [w(' FREE ', 1 * SEC, 1.5 * SEC), w('um', 0.2 * SEC, 0.5 * SEC)] },
      style,
      { styleRef: 'trend/hormozi', language: 'en' },
    )
    expect(spans(p)).toEqual([
      ['um', 200_000, 500_000],
      ['FREE', 1 * SEC, 1.5 * SEC],
    ])
    expect(p.captions!.words[0]!.filler).toBe(true)
    expect(p.captions!.words[1]!.emphasis).toBe(true)
    expect(p.captions).toMatchObject({ enabled: true, language: 'en', styleRef: 'trend/hormozi' })
    expect(p.captions!.style).toEqual(style)
    expect(p.captions!.style).not.toBe(style)
    expect(validateProject(p)).toEqual([])
  })

  it('respects in-points and drops words outside the clip', () => {
    const { p, clips } = projectWithMain([2 * SEC])
    clips[0]!.in = 2 * SEC
    buildCaptions(
      p,
      {
        [clips[0]!.assetId]: [
          w('before', SEC, 1.5 * SEC),
          w('in', 2.5 * SEC, 3 * SEC),
          w('after', 4.5 * SEC, 5 * SEC),
        ],
      },
      plain,
    )
    expect(spans(p)).toEqual([['in', 0.5 * SEC, SEC]])
  })

  it('clamps words straddling a cut to the clip edge (kept when their midpoint is visible)', () => {
    const { p, clips } = projectWithMain([2 * SEC])
    buildCaptions(
      p,
      { [clips[0]!.assetId]: [w('edge', 1.8 * SEC, 2.1 * SEC), w('gone', 1.9 * SEC, 2.5 * SEC)] },
      plain,
    )
    expect(spans(p)).toEqual([['edge', 1.8 * SEC, 2 * SEC]])
  })

  it('handles cut regions and the same asset used multiple times', () => {
    const p = project()
    const a = asset()
    const main = mainTrack(p).id
    const first = insertMediaClip(p, { trackId: main, asset: a, duration: 2 * SEC })
    const second = insertMediaClip(p, { trackId: main, asset: a, duration: 2 * SEC })
    second.in = 5 * SEC
    const third = insertMediaClip(p, { trackId: main, asset: a, duration: 2 * SEC })
    expect(first.in + third.in).toBe(0)
    buildCaptions(
      p,
      {
        [a.id]: [w('a', 0.5 * SEC, SEC), w('cut', 3 * SEC, 3.5 * SEC), w('b', 5.5 * SEC, 6 * SEC)],
      },
      plain,
    )
    expect(spans(p)).toEqual([
      ['a', 0.5 * SEC, SEC],
      ['b', 2.5 * SEC, 3 * SEC],
      ['a', 4.5 * SEC, 5 * SEC],
    ])
  })

  it('respects speed and reverse', () => {
    const { p, clips } = projectWithMain([2 * SEC, 4 * SEC])
    clips[0]!.speed = 2
    clips[1]!.reverse = true
    buildCaptions(
      p,
      {
        [clips[0]!.assetId]: [w('fast', 2 * SEC, 3 * SEC)],
        [clips[1]!.assetId]: [w('one', 0, 0.5 * SEC), w('two', 3 * SEC, 3.5 * SEC)],
      },
      plain,
    )
    expect(spans(p)).toEqual([
      ['fast', SEC, 1.5 * SEC],
      ['two', 2.5 * SEC, 3 * SEC],
      ['one', 5.5 * SEC, 6 * SEC],
    ])
  })

  it('splits transition overlaps at their midpoint so words are never duplicated', () => {
    const p = project()
    const a = asset()
    const main = mainTrack(p).id
    insertMediaClip(p, { trackId: main, asset: a, duration: 2 * SEC })
    const b = insertMediaClip(p, { trackId: main, asset: a, duration: 2 * SEC })
    b.in = 1 * SEC // plays source 1–3 s, overlapping playback 1–2 s with a 1 s transition
    b.transitionIn = { type: 'fade', duration: SEC }
    buildCaptions(p, { [a.id]: words(10, { len: 200_000, gap: 100_000 }) }, plain)
    const out = p.captions!.words
    for (let i = 1; i < out.length; i++)
      expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.start)
    // Words of the first clip end at the 1.5 s midpoint; words of the second clip start there.
    expect(out.every((x) => x.end <= 1.5 * SEC || x.start >= 1.5 * SEC)).toBe(true)
    expect(validateProject(p)).toEqual([])
  })

  it('skips muted clips/tracks, images, music and hidden overlays; includes overlays and voice-over', () => {
    const p = project()
    const main = mainTrack(p)
    const muted = insertMediaClip(p, { trackId: main.id, asset: asset(), duration: SEC })
    muted.audio.muted = true
    insertMediaClip(p, { trackId: main.id, asset: asset({ kind: 'image' }), duration: SEC })
    const overlay = addTrack(p, 'overlay')
    const ov = insertMediaClip(p, { trackId: overlay.id, asset: asset(), at: 0, duration: SEC })
    const hiddenTrack = addTrack(p, 'overlay')
    hiddenTrack.hidden = true
    const hid = insertMediaClip(p, {
      trackId: hiddenTrack.id,
      asset: asset(),
      at: 3 * SEC,
      duration: SEC,
    })
    const vo = insertAudioClip(p, {
      asset: asset({ kind: 'audio' }),
      at: 4 * SEC,
      role: 'voiceover',
    })
    const music = insertAudioClip(p, { asset: asset({ kind: 'audio' }), at: 0 })
    const all = (id: string) => ({ [id]: [w(id, 0.1 * SEC, 0.3 * SEC)] })
    buildCaptions(
      p,
      {
        ...all(muted.assetId),
        ...all(ov.assetId),
        ...all(hid.assetId),
        ...all(vo.assetId),
        ...all(music.assetId),
      },
      plain,
    )
    expect(spans(p)).toEqual([
      [ov.assetId, 0.1 * SEC, 0.3 * SEC],
      [vo.assetId, 4_100_000, 4_300_000],
    ])
    main.muted = true
    muted.audio.muted = false
    buildCaptions(p, all(muted.assetId), plain)
    expect(p.captions!.words).toEqual([])
  })

  it('skips empty and inverted words and keeps an existing enabled flag', () => {
    const { p, clips } = projectWithMain([2 * SEC])
    buildCaptions(p, {}, plain)
    p.captions!.enabled = false
    buildCaptions(
      p,
      { [clips[0]!.assetId]: [w('  ', 0, 100), w('bad', 500, 100), w('ok', 0, 100)] },
      plain,
    )
    expect(spans(p)).toEqual([['ok', 0, 100]])
    expect(p.captions!.enabled).toBe(false)
    expect(p.captions!.language).toBe('auto')
  })
})

describe('caption re-anchoring after main-track edits', () => {
  const setup = () => {
    const { p, clips } = projectWithMain([4 * SEC, 4 * SEC])
    buildCaptions(
      p,
      {
        [clips[0]!.assetId]: [w('a1', 0.5 * SEC, SEC), w('a2', 3 * SEC, 3.5 * SEC)],
        [clips[1]!.assetId]: [w('b1', 0.5 * SEC, SEC)],
      },
      plain,
    )
    return { p, clips }
  }

  it('shifts later words when a clip is trimmed', () => {
    const { p, clips } = setup()
    trimClip(p, clips[0]!.id, { end: 2 * SEC })
    expect(spans(p)).toEqual([
      ['a1', 0.5 * SEC, SEC],
      ['b1', 2.5 * SEC, 3 * SEC],
    ])
  })

  it('follows clips when they are reordered or deleted', () => {
    const { p, clips } = setup()
    moveClip(p, clips[1]!.id, { index: 0 })
    expect(spans(p)).toEqual([
      ['b1', 0.5 * SEC, SEC],
      ['a1', 4.5 * SEC, 5 * SEC],
      ['a2', 7 * SEC, 7.5 * SEC],
    ])
    deleteClips(p, [clips[1]!.id])
    expect(spans(p)).toEqual([
      ['a1', 0.5 * SEC, SEC],
      ['a2', 3 * SEC, 3.5 * SEC],
    ])
  })

  it('re-times words on speed changes and keeps them through splits', () => {
    const { p, clips } = setup()
    setClipSpeed(p, clips[0]!.id, 2)
    expect(spans(p)).toEqual([
      ['a1', 0.25 * SEC, 0.5 * SEC],
      ['a2', 1.5 * SEC, 1.75 * SEC],
      ['b1', 2.5 * SEC, 3 * SEC],
    ])
    splitClip(p, clips[0]!.id, SEC)
    expect(p.captions!.words).toHaveLength(3)
  })

  it('leaves words that are not on an audible main clip untouched', () => {
    const { p, clips } = setup()
    p.captions!.words.push(w('late', 20 * SEC, 21 * SEC))
    trimClip(p, clips[0]!.id, { end: 2 * SEC })
    expect(p.captions!.words.at(-1)).toMatchObject({ text: 'late', start: 20 * SEC })
  })
})
