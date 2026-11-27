import { describe, expect, it } from 'vitest'
import { routeAsk } from '@/editor/panels/ai/ask.ts'

describe('Ask Magic routing', () => {
  it.each([
    ['add captions', { kind: 'tool', id: 'captions' }],
    ['Subtitles please', { kind: 'tool', id: 'captions' }],
    ['cut the pauses', { kind: 'tool', id: 'silence' }],
    ['remove the ums', { kind: 'tool', id: 'fillers' }],
    ['write a hook', { kind: 'tool', id: 'copy' }],
    ['hashtags for my post', { kind: 'tool', id: 'copy' }],
    ['make captions pop with emoji', { kind: 'tool', id: 'emphasis' }],
    ['sync to the beat', { kind: 'tool', id: 'beats' }],
    ['add music', { kind: 'music' }],
    ['make my landscape clip vertical', { kind: 'tool', id: 'reframe' }],
    ['remove the background', { kind: 'tool', id: 'removebg' }],
    ['reduce noise', { kind: 'tool', id: 'voice' }],
    ['keep the best moments', { kind: 'tool', id: 'highlights' }],
    ['split into shots', { kind: 'tool', id: 'scenes' }],
    ['make it a reel', { kind: 'autoedit' }],
  ] as const)('%s', (text, route) => {
    expect(routeAsk(text)).toEqual(route)
  })

  it('says when it does not understand', () => {
    expect(routeAsk('')).toEqual({ kind: 'unknown' })
    expect(routeAsk('   ')).toEqual({ kind: 'unknown' })
    expect(routeAsk('what is the weather')).toEqual({ kind: 'unknown' })
  })
})
