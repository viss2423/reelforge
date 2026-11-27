/**
 * Auto Edit and the language-model tools against a fake host (jobs finish immediately with
 * canned results) and fake music/trends ports, with the real core assembler: what gets
 * analysed, what the host is asked, the resulting timeline, one undo step, variants, music
 * fallbacks, and the vibe → pack style mapping.
 */
import { sec, type Asset, type Job, type Project } from '@reelforge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyAutoEdit,
  autoEdit,
  buildPlan,
  fallbackHookText,
  planAutoEdit,
  type AutoEditDeps,
} from '@/editor/panels/ai/autoedit/flow.ts'
import { parseTracks, parseTrends, type MusicPort } from '@/editor/panels/ai/autoedit/ports.ts'
import {
  autoEditSessions,
  switchVariant,
  uploadsLanded,
} from '@/editor/panels/ai/autoedit/session.ts'
import { pickStyle, trendBoosts, vibeById } from '@/editor/panels/ai/autoedit/style.ts'
import type { FlowContext } from '@/editor/panels/ai/flows.ts'
import type { JobApi, JobDeps, JobInput } from '@/editor/panels/ai/jobs.ts'
import {
  copyResults,
  insertHookText,
  startBestMoments,
  startCopywriter,
  startImproveCaptions,
} from '@/editor/panels/ai/llmtools.ts'
import { readCopy, readEmphasis, readHighlights } from '@/editor/panels/ai/results.ts'
import { createAiTasks, type AiTasks } from '@/editor/panels/ai/tasks.ts'
import { createEditorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { flushMicrotasks, makeAsset, makeProject, videoClip } from '../../fixtures.ts'
import { makeJob, packsFixture, richStore } from './helpers.ts'

vi.mock('@/components/Toast.tsx', () => ({
  toast: Object.assign(vi.fn<(m: string) => void>(), { error: vi.fn<(t: string) => void>() }),
}))

const word = (text: string, start: number, end: number) => ({
  text,
  start,
  end,
  confidence: 1,
  filler: false,
  emphasis: false,
})

/** 12 words, 0.3 s apart from 0. */
const speech = (prefix: string) =>
  Array.from({ length: 12 }, (_, i) => word(`${prefix}${i}`, i * 300_000, i * 300_000 + 250_000))

type Results = Partial<Record<Job['kind'], (input: JobInput) => unknown>>

const highlightResult = (a: string, b: string) => ({
  ranker: 'llm',
  variants: [
    {
      id: 'story',
      label: 'Story',
      moments: [
        { assetId: b, start: sec(1), end: sec(2), role: 'hook', reason: 'bold claim' },
        { assetId: a, start: 0, end: sec(1.5), role: 'value', reason: 'tip' },
      ],
    },
    {
      id: 'chrono',
      label: 'In order',
      moments: [
        { assetId: a, start: 0, end: sec(1), role: 'hook', reason: 'x' },
        { assetId: b, start: 0, end: sec(1), role: 'payoff', reason: 'y' },
      ],
    },
  ],
})

const fakeHost = (results: Results) => {
  const inputs: JobInput[] = []
  let n = 0
  const api: JobApi = {
    createJob: vi.fn<JobApi['createJob']>(async (input: JobInput) => {
      inputs.push(input)
      return makeJob({
        id: `j${++n}`,
        kind: input.kind,
        status: 'done',
        progress: 1,
        result: results[input.kind]?.(input),
      })
    }),
    job: vi.fn<JobApi['job']>(async (id: string) => makeJob({ id, status: 'running' })),
    cancelJob: vi.fn<JobApi['cancelJob']>(async () => undefined),
  }
  const deps: JobDeps = { api, events: { on: () => () => undefined }, pollMs: 60_000 }
  return { deps, inputs, kinds: () => inputs.map((i) => i.kind) }
}

const baseResults = (): Results => ({
  transcribe: (i) => ({ words: speech(i.assetId ?? '') }),
  scenes: () => ({ scenes: [sec(1)] }),
  beats: () => ({ beats: Array.from({ length: 60 }, (_, k) => k * 500_000), bpm: 120 }),
  highlights: () => highlightResult('a1', 'a2'),
  copywriter: () => ({
    hooks: ['Nobody tells you this', 'B', 'C'],
    caption: 'Cap',
    hashtags: ['#a'],
  }),
  emphasis: () => ({
    marks: [{ index: 1, emoji: '🔥' }],
    chapters: [{ index: 0, title: 'Intro' }],
  }),
})

let store: EditorStoreApi
let host: ReturnType<typeof fakeHost>
const ctx = (): FlowContext => ({
  store,
  jobs: host.deps,
  signal: new AbortController().signal,
  report: () => undefined,
})
const project = () => store.getState().project!
const mainOf = (p: Project) => p.tracks.find((t) => t.kind === 'main')!.clips
const allClips = (p: Project) => p.tracks.flatMap((t) => t.clips)

beforeEach(() => {
  store = richStore()
  host = fakeHost(baseResults())
  autoEditSessions.setState({ session: null })
})

describe('Auto edit flow', () => {
  it('analyses the main clips, asks for highlights + copy, and applies one undo step', async () => {
    const before = store.getState().history
    const { result, stats } = await autoEdit(ctx(), {
      target: 30,
      vibe: 'energetic',
      language: 'en',
      llm: true,
      packs: packsFixture(),
    })
    expect(new Set(host.kinds())).toEqual(
      new Set(['transcribe', 'scenes', 'beats', 'highlights', 'copywriter']),
    )
    const hl = host.inputs.find((i) => i.kind === 'highlights')!
    expect(hl.payload).toMatchObject({
      target: sec(30),
      vibe: 'energetic',
      sources: [
        { assetId: 'a1', start: 0, end: sec(2) },
        { assetId: 'a2', start: 0, end: sec(3) },
      ],
    })
    expect(result.variants.map((v) => v.id)).toEqual(['story', 'chrono'])
    const p = project()
    expect(mainOf(p).map((c) => (c.type === 'video' ? [c.assetId, c.in] : null))).toEqual([
      ['a2', sec(1)],
      ['a1', 0],
    ])
    expect(stats.beatSynced).toBe(true)
    expect(stats.musicClipId).toBe('mus')
    const hook = allClips(p).find((c) => c.type === 'text' && c.text === 'Nobody tells you this')
    expect(hook).toBeDefined()
    expect(p.captions?.words.length).toBeGreaterThan(0)
    expect(p.captions?.styleRef).toBe('trend/hormozi')
    expect(store.getState().history.undoLabel).toBe('Auto edit')
    store.getState().undo()
    expect(store.getState().history.canUndo).toBe(before.canUndo)
  })

  it('works without the language model: no copywriter, hook text from the hook moment', async () => {
    const r = await planAutoEdit(ctx(), { target: 15, vibe: 'fun', language: 'auto', llm: false })
    expect(host.kinds()).not.toContain('copywriter')
    expect(r.variants[0]!.plan.hookText?.text).toBe('a23 a24 a25 a26')
  })

  it('adds music from the library when the project has none (vibe mood, energetic section)', async () => {
    store = createEditorStore()
    const a1 = makeAsset({ id: 'a1', duration: sec(10), hasAudio: false })
    store.getState().load(
      makeProject({
        tracks: [
          { id: 'main', kind: 'main', clips: [videoClip(0, sec(4), { assetId: 'a1' })] },
          { id: 'audio', kind: 'audio', clips: [] },
        ],
      }),
      [a1],
    )
    host = fakeHost({ ...baseResults(), highlights: () => highlightResult('a1', 'a1') })
    const song: Asset = makeAsset({
      id: 'song',
      kind: 'audio',
      duration: undefined,
      hasVideo: false,
    })
    const suggest = vi.fn<MusicPort['suggest']>(async () => [
      { id: 't1', title: 'Hype', bpm: 128, startAt: sec(8) },
    ])
    const music: MusicPort = {
      suggest,
      import: vi.fn<MusicPort['import']>(async () => ({ asset: song })),
    }
    const deps: AutoEditDeps = {
      music,
      waitForAsset: async (a) => ({ ...a, duration: sec(60) }),
    }
    const { result, stats } = await autoEdit(
      ctx(),
      { target: 15, vibe: 'energetic', language: 'auto', llm: false },
      deps,
    )
    expect(suggest).toHaveBeenCalledWith(
      { mood: 'energetic', order: 'trend', duration: sec(15), hasSpeech: false },
      expect.anything(),
    )
    expect(host.kinds()).not.toContain('transcribe') // no audio on the clip
    expect(host.inputs.find((i) => i.kind === 'beats')?.assetId).toBe('song')
    expect(result.music).toEqual({ title: 'Hype', imported: true })
    const m = allClips(project()).find((c) => c.id === stats.musicClipId)
    expect(m).toMatchObject({
      type: 'audio',
      assetId: 'song',
      in: sec(8),
      start: 0,
      duckUnderVoice: false,
    })
  })

  it('asks for trend-matched music and reports the trending sound for posting', async () => {
    store = createEditorStore()
    store.getState().load(
      makeProject({
        tracks: [{ id: 'main', kind: 'main', clips: [videoClip(0, sec(4), { assetId: 'a1' })] }],
      }),
      [makeAsset({ id: 'a1', duration: sec(10), hasAudio: false })],
    )
    host = fakeHost({ ...baseResults(), highlights: () => highlightResult('a1', 'a1') })
    const suggest = vi.fn<MusicPort['suggest']>(async () => [])
    const trends = parseTrends({
      sounds: [
        { name: 'Midnight Run', artist: 'Kora', bpm: 140, genre: 'phonk', mood: 'dark', energy: 3 },
      ],
    })!
    const r = await planAutoEdit(
      ctx(),
      { target: 15, vibe: 'fun', language: 'auto', llm: false },
      {
        music: { suggest, import: vi.fn<MusicPort['import']>() },
        trends: { get: async () => trends },
      },
    )
    expect(suggest).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'trend', duration: sec(15), hasSpeech: false }),
      expect.anything(),
    )
    expect(r.trendingSound).toEqual({
      name: 'Midnight Run',
      artist: 'Kora',
      bpm: 140,
      genre: 'phonk',
      mood: 'dark',
      energy: 1,
    })
    expect(r.notes).toContain('no matching music found')
  })

  it('keeps going when the music library fails', async () => {
    store = createEditorStore()
    store.getState().load(
      makeProject({
        tracks: [{ id: 'main', kind: 'main', clips: [videoClip(0, sec(4), { assetId: 'a1' })] }],
      }),
      [makeAsset({ id: 'a1', duration: sec(10) })],
    )
    host = fakeHost({ ...baseResults(), highlights: () => highlightResult('a1', 'a1') })
    const music: MusicPort = {
      suggest: async () => Promise.reject(new Error('down')),
      import: vi.fn<MusicPort['import']>(),
    }
    const { result } = await autoEdit(
      ctx(),
      { target: 15, vibe: 'fun', language: 'auto', llm: false },
      { music },
    )
    expect(result.notes).toContain('music library unavailable')
    expect(mainOf(project())).toHaveLength(2)
  })

  it('refuses an empty timeline', async () => {
    store = createEditorStore()
    store.getState().load(makeProject({ tracks: [{ id: 'main', kind: 'main', clips: [] }] }), [])
    await expect(
      planAutoEdit(ctx(), { target: 15, vibe: 'fun', language: 'auto', llm: false }),
    ).rejects.toThrow(/Add some clips/)
  })

  it('switches variants in place of the Auto edit step, and refuses after later edits', async () => {
    const tasks: AiTasks = createAiTasks({ store, jobs: host.deps })
    const { startAutoEdit } = await import('@/editor/panels/ai/autoedit/session.ts')
    startAutoEdit({ target: 30, vibe: 'energetic', language: 'en', llm: true }, {}, tasks)
    await vi.waitFor(() => expect(autoEditSessions.getState().session).not.toBeNull())
    expect(switchVariant(1, store)).toBe(true)
    expect(mainOf(project()).map((c) => (c.type === 'video' ? c.assetId : ''))).toEqual([
      'a1',
      'a2',
    ])
    expect(store.getState().history.undoLabel).toBe('Auto edit')
    store.getState().undo()
    expect(mainOf(project()).map((c) => c.id)).toEqual(['v1', 'v2']) // single step back to the original
    store.getState().redo()
    store.getState().dispatch('Rename', (d) => {
      d.name = 'x'
    })
    expect(switchVariant(0, store)).toBe(false)
  })

  it('builds plans: hard cuts under speech, bar cuts and ducking with speech', () => {
    const style = pickStyle(packsFixture(), vibeById('energetic'))
    const plan = buildPlan({
      moments: [{ assetId: 'a1', start: 0, end: sec(1), role: 'hook', reason: '' }],
      style,
      vibe: vibeById('energetic'),
      transcripts: { a1: speech('w') },
      hasSpeech: true,
      language: 'en',
      hookText: 'Hi',
      music: { clipId: 'mus', beats: [sec(1)] },
    })
    expect(plan.music).toMatchObject({ every: 4, duck: true, volume: 0.6 })
    expect(plan.transition?.every).toBe(3)
    expect(plan.captions?.language).toBe('en')
    expect(plan.hookText).toMatchObject({ text: 'Hi', presetRef: expect.any(String) })
    expect(fallbackHookText(undefined, {}, ' Lisbon ')).toBe('Lisbon')
  })

  it('knows when Home uploads have landed', () => {
    expect(uploadsLanded('p1', project())).toBe(true)
    expect(uploadsLanded('other', project())).toBe(false)
  })

  it('applyAutoEdit applies a variant directly', async () => {
    const r = await planAutoEdit(ctx(), {
      target: 30,
      vibe: 'cinematic',
      language: 'en',
      llm: true,
    })
    const stats = applyAutoEdit(store, r, r.variants[1]!)
    expect(stats.clips).toBe(2)
  })
})

describe('vibe styles and trends', () => {
  it('maps vibes to pack items and lets the newest trend template win', () => {
    const packs = packsFixture()
    const talking = pickStyle(packs, vibeById('talking'))
    expect(talking.transition).toBeUndefined()
    expect(talking.filter).toBeUndefined()
    const energetic = pickStyle(packs, vibeById('energetic'))
    expect(energetic.transition?.type).toBe('whip')
    expect(energetic.filter?.ref).toBeDefined()
    const trends = parseTrends({
      topics: ['gym', { name: 'travel', vibe: 'cinematic' }],
      templates: [
        { id: 'old', tags: ['beat'], captionStyle: 'trend/hormozi', createdAt: '2026-11-01' },
        {
          ref: 'new',
          tags: ['energy'],
          captionStyle: 'trend/clean',
          filter: 'extra/film',
          createdAt: '2026-11-20',
          musicHint: { title: 'x', bpm: 140 },
        },
        { tags: ['nothing'] },
      ],
    })!
    expect(trends.topics).toEqual([{ name: 'gym' }, { name: 'travel', vibe: 'cinematic' }])
    expect(trends.templates.map((t) => t.ref)).toEqual(['old', 'new'])
    const boosts = trendBoosts(trends, vibeById('energetic'))
    expect(boosts.get('trend/clean')).toBe(100)
    const styled = pickStyle(packs, vibeById('energetic'), trends)
    expect(styled.caption.ref).toBe('trend/clean')
    expect(styled.filter?.ref).toBe('extra/film')
    expect(vibeById('nope').id).toBe('energetic')
  })

  it('parses music suggestions leniently', () => {
    expect(
      parseTracks({
        tracks: [{ id: 't', name: 'Song', bpm: 120, energyStart: 5 }, { title: 'no id' }],
      }),
    ).toEqual([{ id: 't', title: 'Song', bpm: 120, startAt: 5 }])
    expect(parseTracks([{ id: 'x' }])).toEqual([{ id: 'x', title: 'Track' }])
    expect(parseTracks(null)).toEqual([])
    expect(parseTrends('nope')).toBeUndefined()
  })
})

describe('result readers', () => {
  it('read highlights, copy and emphasis defensively', () => {
    const h = readHighlights({
      ranker: 'x',
      variants: [
        {
          moments: [
            { assetId: 'a', start: 0, end: 5, role: 'odd' },
            { assetId: 'a', start: 5, end: 1 },
          ],
        },
        { moments: [] },
      ],
    })
    expect(h).toEqual({
      ranker: 'heuristic',
      variants: [
        {
          id: 'v0',
          label: 'Version 1',
          duration: 5,
          moments: [{ assetId: 'a', start: 0, end: 5, role: 'value', reason: '' }],
        },
      ],
    })
    expect(() => readHighlights({ variants: [] })).toThrow(/unexpected highlights/)
    expect(readCopy({ hooks: ['a', 3, ''], caption: 1, hashtags: ['#x'] })).toEqual({
      hooks: ['a'],
      caption: '',
      hashtags: ['#x'],
    })
    expect(() => readCopy({ hooks: [] })).toThrow(/unexpected copywriter/)
    expect(
      readEmphasis({
        marks: [{ index: 2, emoji: '' }, { index: -1 }],
        chapters: [{ index: 0, title: ' A ' }, { index: 1 }],
      }),
    ).toEqual({
      marks: [{ index: 2 }],
      chapters: [{ index: 0, title: 'A' }],
    })
  })
})

describe('LLM tools', () => {
  let tasks: AiTasks
  beforeEach(() => {
    tasks = createAiTasks({ store, jobs: host.deps })
    copyResults.setState({ current: null })
  })

  it('best moments: review, then one undo step', async () => {
    startBestMoments(15, tasks)
    await vi.waitFor(() => expect(tasks.store.getState().tasks.highlights?.status).toBe('review'))
    expect(tasks.store.getState().tasks.highlights?.review?.summary).toMatch(
      /2 moments · 2\.5 s · picked by AI/,
    )
    tasks.apply('highlights')
    expect(store.getState().history.undoLabel).toBe('Auto-cut best moments')
    expect(mainOf(project())).toHaveLength(2)
  })

  it('copywriter stores the copy; hook text inserts as a text clip', async () => {
    startCopywriter(tasks)
    await vi.waitFor(() =>
      expect(copyResults.getState().current?.copy.hooks[0]).toBe('Nobody tells you this'),
    )
    insertHookText('Nobody tells you this', packsFixture(), store)
    const t = allClips(project()).find(
      (c) => c.type === 'text' && c.text === 'Nobody tells you this',
    )
    expect(t).toMatchObject({ start: 0 })
  })

  it('improve captions: needs captions, then applies emphasis and chapters', async () => {
    startImproveCaptions({ chapters: true }, tasks)
    await vi.waitFor(() => expect(tasks.store.getState().tasks.emphasis?.status).toBe('error'))
    store.getState().dispatch('caps', (d) => {
      d.captions = {
        enabled: true,
        language: 'en',
        words: speech('w'),
        style: pickStyle(undefined, vibeById('fun')).caption.style,
      }
    })
    startImproveCaptions({ chapters: true }, tasks)
    await vi.waitFor(() => expect(tasks.store.getState().tasks.emphasis?.status).toBe('review'))
    tasks.apply('emphasis')
    await flushMicrotasks()
    const words = project().captions!.words
    expect(words[1]).toMatchObject({ emphasis: true, emoji: '🔥' })
    expect(project().markers.some((m) => m.label === 'Intro')).toBe(true)
  })
})
