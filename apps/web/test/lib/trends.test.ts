import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { Job } from '@reelforge/core'
import { applyServerEvent, qk } from '@/api/queries.ts'
import type { Packs } from '@/api/schemas.ts'
import { latestMatchingTemplate, listTemplates } from '@/lib/packs.ts'
import { autoEditUrl, vibeForIdea, postText, sourceLabel, trendsIntegration } from '@/lib/trends.ts'

const tpl = (id: string, name: string, trendScore: number, tags: string[] = []) => ({
  id,
  name,
  trendScore,
  tags,
  description: '',
  slots: [{ duration: 1_000_000 }],
})

const packs = {
  index: { fonts: [] },
  manifests: [
    { id: 'trending-2026-11', templates: [tpl('hot', 'Hot One', 99, ['photo-dump'])] },
    {
      id: 'trending-live',
      templates: [
        tpl('old', 'Carried Over', 90),
        tpl('fresh', 'Snow Day Dump', 88, ['new', 'winter']),
      ],
    },
  ],
} as unknown as Packs

describe('generated templates come first', () => {
  it('fresh live → carried live → everything else', () => {
    const items = [
      { ref: 'trending-live/fresh', trend: 'photo dump', fresh: true },
      { ref: 'trending-live/old', trend: 'cozy', fresh: false },
    ] as never
    const list = listTemplates(packs, { items })
    expect(list.map((t) => t.ref)).toEqual([
      'trending-live/fresh',
      'trending-live/old',
      'trending-2026-11/hot',
    ])
    expect(list[0]).toMatchObject({ fresh: true, trend: 'photo dump' })
    expect(list[1]).toMatchObject({ fresh: false, trend: 'cozy' })
    expect(list[2]!.fresh).toBe(false)
  })

  it('falls back to the "new" tag before trend data arrives', () => {
    const list = listTemplates(packs)
    expect(list[0]).toMatchObject({ ref: 'trending-live/fresh', fresh: true })
  })

  it('latest matching template for a topic', () => {
    const list = listTemplates(packs)
    expect(latestMatchingTemplate(list, 'winter snow')!.ref).toBe('trending-live/fresh')
    expect(latestMatchingTemplate(list, 'photo dump')!.ref).toBe('trending-2026-11/hot')
    expect(latestMatchingTemplate(list, 'zzz')!.ref).toBe('trending-live/fresh')
  })
})

describe('trend helpers', () => {
  const idea = {
    topic: 'snow day',
    title: 'Snow',
    hooks: ['POV: snow'],
    shots: ['a', 'b'],
    caption: 'Cold!',
    hashtags: ['snow', '#winter'],
    template: '',
  }
  it('post text and labels', () => {
    expect(postText(idea)).toBe('Cold!\n\n#snow #winter')
    expect(sourceLabel('google-trends')).toBe('Google Trends')
    expect(sourceLabel('x')).toBe('x')
  })

  it('Make this reel opens Auto Edit with topic and vibe (template sheet when unset)', () => {
    expect(autoEditUrl(idea, 'p/t')).toBe(
      '/?autoedit=1&topic=snow+day&vibe=fun&template=p%2Ft&hook=POV%3A+snow',
    )
    expect(vibeForIdea({ ...idea, hooks: ['3 tips for budgeting'], shots: [] })).toBe('talking')
    expect(vibeForIdea({ ...idea, topic: 'x', title: 'y', hooks: [], shots: [] })).toBe('energetic')
    const saved = trendsIntegration.autoEditPath
    delete trendsIntegration.autoEditPath
    expect(autoEditUrl(idea, 'p/t')).toBeUndefined()
    trendsIntegration.autoEditPath = saved
  })

  it('a finished trends job or a packs event refreshes trend data', () => {
    const qc = new QueryClient()
    qc.setQueryData(qk.trends, { generatedAt: null })
    const job = { id: 'j1', kind: 'trends', status: 'done', progress: 1, createdAt: '' } as Job
    applyServerEvent(qc, { type: 'job', job })
    expect(qc.getQueryState(qk.trends)?.isInvalidated).toBe(true)
    qc.setQueryData(qk.trends, { generatedAt: null })
    applyServerEvent(qc, { type: 'packs', version: 'v' })
    expect(qc.getQueryState(qk.trends)?.isInvalidated).toBe(true)
  })
})
