import { sec } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import { HANDLE_SLOP_MOUSE, HANDLE_SLOP_TOUCH, HANDLE_WIDTH } from '@/editor/timeline/constants.ts'
import { layoutRows, pxPerUs, timeToX, type Row } from '@/editor/timeline/geometry.ts'
import { hitTest, markerNear, wordAt, type HitContext } from '@/editor/timeline/hitTest.ts'
import { clip, mainClips, track } from './helpers.ts'

const ppu = pxPerUs(100) // 100 px per second
const main = track('main', mainClips(2, 1, 3))
const text = track('text', [clip('text', sec(1), sec(2), { id: 'tx' })], 'tx-track')
const { rows } = layoutRows([main, text], true)
const rowOf = (key: string): Row => rows.find((r) => r.key === key)!
const midY = (key: string) => rowOf(key).y + rowOf(key).height / 2

const ctx = (over: Partial<HitContext> = {}): HitContext => ({
  rows,
  ppu,
  selected: new Set(),
  touch: false,
  markers: [{ id: 'mk', t: sec(4), kind: 'user' }],
  words: [
    { text: 'hi', start: 0, end: sec(0.5), confidence: 1, filler: false, emphasis: false },
    { text: 'there', start: sec(0.6), end: sec(1), confidence: 1, filler: false, emphasis: false },
  ],
  ...over,
})
const x = (t: number) => timeToX(t, ppu)

describe('hitTest', () => {
  it('hits clip bodies with their playback span', () => {
    const h = hitTest(ctx(), x(sec(2.5)), midY('main'))
    expect(h).toMatchObject({
      kind: 'clip',
      index: 1,
      zone: 'body',
      start: sec(2),
      end: sec(3),
      clip: { id: 'm1' },
    })
  })

  it('finds thin trim zones on unselected clips with a mouse', () => {
    expect(hitTest(ctx(), x(sec(2)) + 2, midY('main'))).toMatchObject({
      zone: 'trim-start',
      index: 1,
    })
    expect(hitTest(ctx(), x(sec(3)) - 2, midY('main'))).toMatchObject({
      zone: 'trim-end',
      index: 1,
    })
    expect(hitTest(ctx(), x(sec(2)) + HANDLE_SLOP_MOUSE + 2, midY('main'))).toMatchObject({
      zone: 'body',
    })
  })

  it('uses the full visible handle width on selected clips', () => {
    const c = ctx({ selected: new Set(['m1']) })
    expect(hitTest(c, x(sec(2)) + HANDLE_WIDTH - 1, midY('main'))).toMatchObject({
      zone: 'trim-start',
    })
  })

  it('limits handle zones to a third of tiny clips so they stay movable', () => {
    const tiny = track('main', mainClips(0.1, 1))
    const r = layoutRows([tiny], false).rows
    const c = ctx({ rows: r, selected: new Set(['m0']) })
    const y = r[1]!.y + 10
    // 0.1 s = 10 px wide: the inner zone is ~3.3 px each side, the middle is body.
    expect(hitTest(c, x(sec(0.05)), y)).toMatchObject({ zone: 'body', index: 0 })
  })

  it('grabs a handle from just outside the clip within the outer slop', () => {
    const end = x(sec(6))
    expect(hitTest(ctx(), end + HANDLE_SLOP_MOUSE - 1, midY('main'))).toMatchObject({
      zone: 'trim-end',
      index: 2,
    })
    expect(hitTest(ctx(), end + HANDLE_SLOP_MOUSE + 2, midY('main'))).toMatchObject({
      kind: 'track',
    })
  })

  it('on touch only selected clips get handles, with a larger slop', () => {
    const y = midY('tx-track')
    const start = x(sec(1))
    expect(hitTest(ctx({ touch: true }), start + 2, y)).toMatchObject({ zone: 'body' })
    expect(hitTest(ctx({ touch: true }), start - 4, y)).toMatchObject({ kind: 'track' })
    const sel = ctx({ touch: true, selected: new Set(['tx']) })
    expect(hitTest(sel, start + 2, y)).toMatchObject({ zone: 'trim-start' })
    expect(hitTest(sel, start - HANDLE_SLOP_TOUCH + 1, y)).toMatchObject({ zone: 'trim-start' })
  })

  it('resolves markers, caption words, empty track space and outside rows', () => {
    expect(hitTest(ctx(), x(sec(4)) + 3, midY('markers'))).toMatchObject({
      kind: 'markers',
      marker: { id: 'mk' },
    })
    expect(hitTest(ctx(), x(sec(2)), midY('markers'))).toMatchObject({ marker: null })
    expect(hitTest(ctx(), x(sec(0.7)), midY('captions'))).toMatchObject({
      kind: 'captions',
      word: 1,
    })
    expect(hitTest(ctx(), x(sec(0.55)), midY('captions'))).toMatchObject({ word: -1 })
    expect(hitTest(ctx(), x(sec(5)), midY('tx-track'))).toMatchObject({ kind: 'track' })
    expect(hitTest(ctx(), x(sec(1)), 10_000)).toMatchObject({ kind: 'empty' })
  })
})

describe('wordAt / markerNear', () => {
  it('wordAt returns -1 outside words', () => {
    const words = ctx().words
    expect(wordAt(words, 0)).toBe(0)
    expect(wordAt(words, sec(0.5))).toBe(-1)
    expect(wordAt(words, sec(2))).toBe(-1)
    expect(wordAt([], 0)).toBe(-1)
  })

  it('markerNear picks the closest within the slop', () => {
    const ms = [
      { id: 'a', t: 100, kind: 'user' as const },
      { id: 'b', t: 160, kind: 'beat' as const },
    ]
    expect(markerNear(ms, 140, 50)?.id).toBe('b')
    expect(markerNear(ms, 300, 50)).toBeNull()
  })
})
