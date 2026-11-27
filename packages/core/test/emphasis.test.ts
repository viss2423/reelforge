import { describe, expect, it } from 'vitest'
import { applyCaptionEmphasis, buildCaptions } from '../src/index.ts'
import { captionStyle, projectWithMain, words } from './helpers.ts'

describe('applyCaptionEmphasis', () => {
  const setup = () => {
    const { p, clips } = projectWithMain([4_000_000])
    buildCaptions(p, { [clips[0]!.assetId]: words(10) }, captionStyle({ emphasizeKeywords: false }))
    p.captions!.words[1]!.emphasis = true
    return p
  }

  it('replaces emphasis with the marks, skipping words that changed', () => {
    const p = setup()
    const n = applyCaptionEmphasis(p, [
      { index: 3, text: 'w3', emoji: '🔥' },
      { index: 5, text: 'edited' },
      { index: 99, text: 'w99' },
    ])
    expect(n).toBe(1)
    const w = p.captions!.words
    expect(w.filter((x) => x.emphasis).map((x) => x.text)).toEqual(['w3'])
    expect(w[3]!.emoji).toBe('🔥')
  })

  it('adds chapter markers at the word times and replaces earlier ones', () => {
    const p = setup()
    applyCaptionEmphasis(
      p,
      [],
      [
        { index: 0, title: 'Intro' },
        { index: 6, title: 'Tip' },
      ],
    )
    applyCaptionEmphasis(p, [], [{ index: 6, title: 'Tip' }])
    expect(p.markers.map((m) => [m.t, m.label])).toEqual([[p.captions!.words[6]!.start, 'Tip']])
  })

  it('is a no-op without captions', () => {
    const { p } = projectWithMain([1_000_000])
    expect(applyCaptionEmphasis(p, [{ index: 0, text: 'x' }])).toBe(0)
  })
})
