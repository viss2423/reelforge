/**
 * AI flows end to end against a fake host: which assets get analysed, how results map onto
 * core ops, one undo step per AI action, progress, failure + retry and cancellation.
 * Core ops still stubbed on this branch are faked (fakeCore.ts); assertions on the fakes'
 * calls check the arguments the flows hand to core.
 */
import * as core from '@reelforge/core'
import { sec, type Job, type MediaClip } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  applyCutPlan,
  autoCaptions,
  autoReframe,
  beatSync,
  cutStats,
  isLandscape,
  landscapeClips,
  magicEdit,
  musicClips,
  planFillers,
  planSilence,
  splitScenes,
  timelineBeats,
  type FlowContext,
} from '@/editor/panels/ai/flows.ts'
import type { JobApi, JobDeps, JobInput } from '@/editor/panels/ai/jobs.ts'
import {
  captionStyleFor,
  DEFAULT_CAPTION_STYLE,
  startBeatSync,
  startCaptions,
  startFillers,
  startMagic,
  startReframe,
  startScenes,
  startSilence,
} from '@/editor/panels/ai/launch.ts'
import {
  readBeats,
  readReframe,
  readScenes,
  readSilence,
  readTranscript,
} from '@/editor/panels/ai/results.ts'
import { createAiTasks, type AiTasks } from '@/editor/panels/ai/tasks.ts'
import { createEditorStore, editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { flushMicrotasks, makeAsset } from '../../fixtures.ts'
import {
  audioClip,
  clipIn,
  makeJob,
  packsFixture,
  richAssets,
  richProject,
  richStore,
} from './helpers.ts'

vi.mock('@reelforge/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@reelforge/core')>()
  const { fakeCore } = await import('./fakeCore.ts')
  return { ...real, ...fakeCore(real) }
})

const toasts = vi.hoisted(() => ({
  plain: vi.fn<typeof import('@/components/Toast.tsx').toast>(),
  error: vi.fn<(title: string, description?: string) => number>(),
}))
vi.mock('@/components/Toast.tsx', () => ({
  toast: Object.assign(toasts.plain, { error: toasts.error }),
}))

const fake = core as unknown as Record<
  'removeSourceRanges' | 'buildCaptions' | 'syncToBeats' | 'applyReframe',
  Mock
>
/** Call arguments after the (revoked) draft. */
const args = (m: Mock): unknown[][] => m.mock.calls.map((c) => c.slice(1))

const word = (text: string, start: number, end: number) => ({
  text,
  start,
  end,
  confidence: 1,
  filler: false,
  emphasis: false,
})

/** Host results per job kind and asset. */
type Results = Partial<Record<Job['kind'], (assetId: string) => unknown>>

const defaultResults: Results = {
  silence: () => ({ ranges: [{ start: sec(0.5), end: sec(1) }] }),
  transcribe: (a) => ({
    words: [
      word('hello', 0, sec(0.4)),
      word('um', sec(1.2), sec(1.4)),
      word(a, sec(1.5), sec(1.8)),
    ],
  }),
  beats: () => ({ beats: [0, sec(1), sec(2), sec(40)], bpm: 60 }),
  scenes: () => ({ scenes: [sec(1), sec(2.5)] }),
  reframe: () => ({
    path: [
      { t: 0, x: 0.3 },
      { t: sec(1), x: 0.6 },
    ],
  }),
}

/**
 * A host that finishes every job on the next tick (or fails it / leaves it hanging),
 * recording the inputs it was given.
 */
const fakeHost = (results: Results = defaultResults) => {
  const inputs: JobInput[] = []
  let n = 0
  let failNext: string | undefined
  let hang = false
  const listeners = new Set<(e: { type: 'job'; job: Job }) => void>()
  const api = {
    createJob: vi.fn<JobApi['createJob']>(async (input: JobInput) => {
      inputs.push(input)
      const id = `j${++n}`
      if (hang) return makeJob({ id, kind: input.kind, status: 'running' })
      if (failNext) {
        const error = failNext
        failNext = undefined
        return makeJob({ id, kind: input.kind, status: 'failed', error })
      }
      return makeJob({
        id,
        kind: input.kind,
        status: 'done',
        progress: 1,
        result: results[input.kind]?.(input.assetId ?? ''),
      })
    }),
    job: vi.fn<JobApi['job']>(async (id: string) => makeJob({ id, status: 'running' })),
    cancelJob: vi.fn<JobApi['cancelJob']>(async () => undefined),
  }
  const deps: JobDeps = {
    api,
    events: {
      on: (_t, cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
    pollMs: 60_000,
  }
  return {
    api,
    deps,
    inputs,
    failNext: (msg: string) => {
      failNext = msg
    },
    hang: (on: boolean) => {
      hang = on
    },
    emit: (job: Job) => {
      for (const l of listeners) l({ type: 'job', job })
    },
  }
}

let store: EditorStoreApi
let host: ReturnType<typeof fakeHost>
let reports: Array<[number, string]>
const ctx = (signal = new AbortController().signal): FlowContext => ({
  store,
  jobs: host.deps,
  signal,
  report: (p, l) => reports.push([p, l]),
})
const s = () => store.getState()
const style = DEFAULT_CAPTION_STYLE

beforeEach(() => {
  store = richStore()
  host = fakeHost()
  reports = []
})

describe('results readers', () => {
  it('validate and normalise host payloads', () => {
    expect(
      readTranscript({ words: [{ text: 'a', start: 1.4, end: 0.2 }, { text: 1 }], language: 'en' }),
    ).toEqual({
      words: [{ text: 'a', start: 1, end: 1, confidence: 1, filler: false, emphasis: false }],
      language: 'en',
    })
    expect(() => readTranscript(null)).toThrow(/unexpected transcript/)
    expect(
      readSilence({
        ranges: [
          { start: 5, end: 2 },
          { start: 1, end: 3 },
        ],
      }),
    ).toEqual([{ start: 1, end: 3 }])
    expect(readBeats({ beats: [3, 1, -1, 'x'] })).toEqual({ beats: [1, 3], bpm: 0 })
    expect(readScenes({ scenes: [2, 1] })).toEqual([1, 2])
    expect(() => readScenes({})).toThrow(/unexpected scenes/)
    expect(
      readReframe({
        path: [
          { t: 0, x: 1.5 },
          { t: 1, x: Number.NaN },
        ],
      }),
    ).toEqual([{ t: 0, x: 1 }])
  })
})

describe('silence & fillers', () => {
  it('analyses each audible main-track asset once and previews the saving', async () => {
    s().upsertAsset(makeAsset({ id: 'a2', duration: sec(10), hasAudio: false }))
    const plan = await planSilence(ctx())
    expect(host.inputs.map((i) => [i.kind, i.assetId])).toEqual([['silence', 'a1']])
    expect(plan).toEqual({ scope: 'main', ranges: { a1: [{ start: sec(0.5), end: sec(1) }] } })
    expect(cutStats(s().project!, store, plan)).toEqual({ count: 1, removed: sec(0.5) })
    expect(reports[0]).toEqual([0, 'Finding silences'])
    expect(reports.at(-1)![0]).toBe(1)
  })

  it('applies a cut plan to every clip of the asset as one undo step', async () => {
    const plan = await planSilence(ctx())
    const before = s().project
    const stats = applyCutPlan(store, plan, 'Remove silences')
    expect(stats).toEqual({ count: 2, removed: sec(1) })
    expect(args(fake.removeSourceRanges)).toEqual([
      ['v1', [{ start: sec(0.5), end: sec(1) }]],
      ['v2', [{ start: sec(0.5), end: sec(1) }]],
    ])
    expect(clipIn<MediaClip>(store, 'v1').duration).toBe(sec(1.5))
    s().undo()
    expect(s().project).toEqual(before)
    // Nothing to cut → nothing recorded.
    expect(applyCutPlan(store, { scope: 'main', ranges: {} }, 'x')).toEqual({
      count: 0,
      removed: 0,
    })
  })

  it('only cuts the part of a range inside the clip window', () => {
    const plan = { scope: 'main' as const, ranges: { a2: [{ start: sec(2.5), end: sec(4) }] } }
    expect(cutStats(s().project!, store, plan)).toEqual({ count: 1, removed: sec(0.5) })
  })

  it('needs speech on the main track', async () => {
    store = createEditorStore()
    store.getState().load(richProject(), [])
    for (const a of Object.values(richAssets()))
      store.getState().upsertAsset({ ...a, hasAudio: false })
    await expect(planSilence(ctx())).rejects.toThrow(/video with sound/)
  })

  it('finds fillers from cached transcripts without a host job', async () => {
    s().upsertAsset(
      makeAsset({
        id: 'a1',
        transcript: [word('so', 0, sec(0.3)), word('uh', sec(0.4), sec(0.6))],
      }),
    )
    s().upsertAsset(makeAsset({ id: 'a2', transcript: [word('fine', 0, sec(0.3))] }))
    const plan = await planFillers(ctx())
    expect(host.inputs).toEqual([])
    expect(plan.ranges.a1).toEqual([{ start: sec(0.36), end: sec(0.64) }])
    expect(plan.ranges.a2).toEqual([])
  })

  it('transcribes in the chosen language (no cache) and includes voiceovers', async () => {
    store.getState().dispatch('vo', (d) => {
      d.tracks[3]!.clips.push(
        core.AudioClip.parse(
          audioClip(sec(6), sec(1), { id: 'vo', assetId: 'voice', role: 'voiceover' }),
        ),
      )
    })
    await planFillers(ctx(), 'de')
    expect(host.inputs.map((i) => [i.assetId, i.payload])).toEqual([
      ['a1', { assetId: 'a1', language: 'de' }],
      ['a2', { assetId: 'a2', language: 'de' }],
      ['voice', { assetId: 'voice', language: 'de' }],
    ])
  })
})

describe('captions', () => {
  it('transcribes every speech source and builds captions in one undo step', async () => {
    const words = await autoCaptions(ctx(), { style, styleRef: 'trend/hormozi', language: 'auto' })
    // a1, a2 (main) and a3 (overlay video) each return three words.
    expect(words).toBe(9)
    expect(host.inputs.map((i) => i.assetId)).toEqual(['a1', 'a2', 'a3'])
    const [[transcripts, usedStyle, opts]] = args(fake.buildCaptions) as [
      [Record<string, unknown[]>, unknown, unknown],
    ]
    expect(Object.keys(transcripts)).toEqual(['a1', 'a2', 'a3'])
    expect(usedStyle).toBe(style)
    expect(opts).toEqual({ language: 'auto', styleRef: 'trend/hormozi' })
    expect(s().project!.captions?.styleRef).toBe('trend/hormozi')
    expect(reports.some(([, l]) => l === 'Building captions')).toBe(true)
    s().undo()
    expect(s().project!.captions).toBeUndefined()
  })

  it('reports no speech and project switches as errors', async () => {
    host = fakeHost({ transcribe: () => ({ words: [] }) })
    await expect(autoCaptions(ctx(), { style, language: 'auto' })).rejects.toThrow(/No speech/)
    host = fakeHost()
    const p = autoCaptions(ctx(), { style, language: 'auto' })
    s().load(richProject().id === 'p1' ? { ...richProject(), id: 'other' } : richProject())
    await expect(p).rejects.toThrow(/project was closed/)
  })
})

describe('beats', () => {
  it('maps beats through the music clip, writes markers and syncs cuts', async () => {
    const n = await beatSync(ctx(), { musicClipId: 'mus', every: 2 })
    // 40 s is past the 5 s clip.
    expect(n).toBe(3)
    expect(
      s()
        .project!.markers.filter((m) => m.kind === 'beat')
        .map((m) => m.t),
    ).toEqual([0, sec(1), sec(2)])
    expect(args(fake.syncToBeats)).toEqual([[[0, sec(1), sec(2)], { every: 2 }]])
    s().undo()
    expect(s().project!.markers).toEqual([])
  })

  it('reuses cached beats and validates the music clip', async () => {
    s().upsertAsset(makeAsset({ id: 'music', kind: 'audio', beats: [sec(0.5)] }))
    expect(await beatSync(ctx(), { musicClipId: 'mus', every: 1 })).toBe(1)
    expect(host.inputs).toEqual([])
    await expect(beatSync(ctx(), { musicClipId: 'v1', every: 1 })).rejects.toThrow(/music clip/)
  })

  it('lists music clips longest first and maps beats uniquely', () => {
    expect(musicClips(s().project!).map((c) => c.id)).toEqual(['mus'])
    const clip = clipIn<core.AudioClip>(store, 'mus')
    expect(timelineBeats(clip, [sec(2), sec(1), sec(1), sec(99)])).toEqual([sec(1), sec(2)])
  })
})

describe('scenes & reframe', () => {
  it('splits main-track videos at scene changes', async () => {
    // Scenes at 1 s and 2.5 s (source): v1 [0,2) splits at 1 s; v2 (in 0, start 2 s) splits at 3 s & 4.5 s.
    const n = await splitScenes(ctx())
    expect(n).toBe(3)
    expect(s().project!.tracks[0]!.clips).toHaveLength(5)
    s().undo()
    expect(s().project!.tracks[0]!.clips).toHaveLength(2)
  })

  it('detects landscape media, honouring rotation', () => {
    expect(isLandscape(makeAsset({ width: 1920, height: 1080 }))).toBe(true)
    expect(isLandscape(makeAsset({ width: 1920, height: 1080, rotation: 90 }))).toBe(false)
    expect(isLandscape(makeAsset({ width: 1080, height: 1920, rotation: -90 }))).toBe(true)
    expect(isLandscape(undefined)).toBe(false)
    expect(landscapeClips(s().project!, s().assets).map((c) => c.id)).toEqual(['ov1'])
  })

  it('reframes only landscape clips (optionally a subset)', async () => {
    expect(await autoReframe(ctx())).toBe(1)
    expect(args(fake.applyReframe)).toEqual([
      [
        'ov1',
        [
          { t: 0, x: 0.3 },
          { t: sec(1), x: 0.6 },
        ],
      ],
    ])
    await expect(autoReframe(ctx(), ['v1'])).rejects.toThrow(/no landscape clips/)
  })
})

describe('magic edit', () => {
  it('cuts silences + fillers, beat-syncs and captions as ONE undo step', async () => {
    const before = s().project
    const summary = await magicEdit(ctx(), { style, language: 'auto' })
    expect(summary).toMatchObject({ silences: 2, beatSynced: true, captionWords: 9 })
    expect(summary.fillers).toBe(2)
    expect(summary.removed).toBeGreaterThan(sec(1))
    expect(new Set(host.inputs.map((i) => i.kind))).toEqual(
      new Set(['silence', 'transcribe', 'beats']),
    )
    expect(fake.syncToBeats).toHaveBeenCalledTimes(1)
    expect(s().history.undoLabel).toBe('Magic edit')
    s().undo()
    expect(s().project).toEqual(before)
    expect(s().history.canUndo).toBe(false)
  })

  it('skips beat sync without music and progress never goes backwards', async () => {
    s().dispatch('rm', (d) => {
      d.tracks[3]!.clips = []
    })
    const summary = await magicEdit(ctx(), { style, language: 'auto' })
    expect(summary.beatSynced).toBe(false)
    const ps = reports.map(([p]) => p)
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]!)
  })
})

describe('AI tasks', () => {
  let tasks: AiTasks
  beforeEach(() => {
    tasks = createAiTasks({ store, jobs: host.deps })
  })
  const state = (id: 'silence' | 'captions' | 'scenes' = 'silence') =>
    tasks.store.getState().tasks[id]

  it('runs a flow, tracks progress and toasts with undo when done', async () => {
    tasks.start('scenes', 'Split at scenes', async (c) => ({
      kind: 'done',
      message: `split ${await splitScenes(c)}`,
    }))
    expect(state('scenes')).toMatchObject({
      status: 'running',
      progress: 0,
      label: 'Split at scenes',
    })
    await vi.waitFor(() => expect(state('scenes')).toBeUndefined())
    expect(toasts.plain).toHaveBeenCalledWith(
      'split 3',
      expect.objectContaining({ tone: 'success', action: expect.any(Object) }),
    )
    const undo = toasts.plain.mock.calls[0]![1]!.action!.onClick
    undo()
    expect(s().project!.tracks[0]!.clips).toHaveLength(2)
  })

  it('a review step waits for confirmation, then applies as one step', async () => {
    tasks.start('silence', 'Remove silences', async () => ({
      kind: 'review',
      summary: '2 silences',
      apply: () => {
        s().dispatch('Remove silences', (d) => {
          d.markers.push({ id: 'm', t: 0, kind: 'user' })
        })
        return 'Removed 2 silences'
      },
    }))
    await vi.waitFor(() => expect(state()?.status).toBe('review'))
    expect(state()?.review).toEqual({ summary: '2 silences' })
    expect(s().project!.markers).toEqual([])
    tasks.apply('silence')
    expect(state()).toBeUndefined()
    expect(s().project!.markers).toHaveLength(1)
    expect(toasts.plain).toHaveBeenCalledWith(
      'Removed 2 silences',
      expect.objectContaining({ tone: 'success' }),
    )
  })

  it('shows failures and retries with the same inputs', async () => {
    host.failNext('silencedetect crashed')
    startSilence({ minSilence: 300_000 }, tasks)
    await vi.waitFor(() => expect(state()?.status).toBe('error'))
    expect(state()?.error).toBe('silencedetect crashed')
    tasks.retry('silence')
    await vi.waitFor(() => expect(state()?.status).toBe('review'))
    expect(host.inputs.at(-1)!.payload).toEqual({ assetId: 'a2', minSilence: 300_000 })
  })

  it('cancel aborts the running flow and cancels host jobs', async () => {
    host.hang(true)
    startCaptions({ style, language: 'auto' }, tasks)
    await flushMicrotasks(10)
    expect(state('captions')?.status).toBe('running')
    tasks.cancel('captions')
    expect(state('captions')).toBeUndefined()
    await flushMicrotasks(10)
    expect(host.api.cancelJob).toHaveBeenCalled()
    expect(toasts.plain).not.toHaveBeenCalled()
  })

  it('drops results for a project that is no longer open', async () => {
    host.hang(true)
    startScenes(tasks)
    await flushMicrotasks(10)
    s().load({ ...richProject(), id: 'other' }, Object.values(richAssets()))
    for (const id of ['j1', 'j2'])
      host.emit(
        makeJob({ id, kind: 'scenes', status: 'done', progress: 1, result: { scenes: [sec(1)] } }),
      )
    await vi.waitFor(() => expect(state('scenes')).toBeUndefined())
    expect(toasts.plain).not.toHaveBeenCalled()
  })

  it('apply on a stale review dismisses; failing apply shows the error', async () => {
    tasks.start('silence', 'x', async () => ({
      kind: 'review',
      summary: 's',
      apply: () => {
        throw new Error('nope')
      },
    }))
    await vi.waitFor(() => expect(state()?.status).toBe('review'))
    tasks.apply('silence')
    expect(state()).toMatchObject({ status: 'error', error: 'nope' })
    tasks.dismiss('silence')
    expect(state()).toBeUndefined()
  })
})

describe('launchers (singleton store)', () => {
  let tasks: AiTasks
  beforeEach(() => {
    editorStore.getState().load(richProject(), Object.values(richAssets()))
    tasks = createAiTasks({ store: editorStore, jobs: host.deps })
  })
  afterEach(() => editorStore.getState().unload())

  const waitIdle = (id: Parameters<AiTasks['cancel']>[0]) =>
    vi.waitFor(() => expect(tasks.store.getState().tasks[id]?.status).not.toBe('running'))

  it('silence: review summary with the saving, apply removes', async () => {
    startSilence({}, tasks)
    await waitIdle('silence')
    expect(tasks.store.getState().tasks.silence?.review?.summary).toBe('2 silences · saves 1.0 s')
    tasks.apply('silence')
    expect(toasts.plain).toHaveBeenCalledWith('Removed 2 silences', expect.anything())
    expect(editorStore.getState().history.undoLabel).toBe('Remove silences')
  })

  it('fillers with nothing to cut finish without an undo action', async () => {
    host = fakeHost({ transcribe: () => ({ words: [word('clean', 0, 10)] }) })
    tasks = createAiTasks({ store: editorStore, jobs: host.deps })
    startFillers('auto', tasks)
    await vi.waitFor(() => expect(toasts.plain).toHaveBeenCalled())
    expect(toasts.plain).toHaveBeenCalledWith('No filler words found', { tone: 'success' })
  })

  it('captions, beat sync, scenes, reframe and magic produce friendly messages', async () => {
    startCaptions({ style, language: 'auto' }, tasks)
    startBeatSync({ musicClipId: 'mus', every: 4 }, tasks)
    await vi.waitFor(() => expect(toasts.plain).toHaveBeenCalledTimes(2))
    const messages = () => toasts.plain.mock.calls.map((c) => c[0])
    expect(messages()).toEqual(
      expect.arrayContaining(['Captioned 9 words', 'Synced cuts to 3 beats']),
    )
    startReframe(undefined, tasks)
    await vi.waitFor(() => expect(messages()).toContain('Reframed 1 clip to follow the subject'))
    startMagic({ style, language: 'auto' }, tasks)
    await vi.waitFor(() =>
      expect(messages().some((m) => m.startsWith('Cut 2 silences & 2 filler words'))).toBe(true),
    )
    expect(messages().at(-1)).toMatch(/synced to the beat and captioned$/)
  })

  it('captionStyleFor prefers the project style, then the top pack style, then the default', () => {
    expect(captionStyleFor(undefined)).toEqual({ style: DEFAULT_CAPTION_STYLE })
    const packs = packsFixture()
    expect(captionStyleFor(packs).ref).toBe('trend/hormozi')
    editorStore.getState().dispatch('c', (d) => {
      d.captions = {
        enabled: true,
        language: 'en',
        words: [],
        style: DEFAULT_CAPTION_STYLE,
        styleRef: 'mine/x',
      }
    })
    expect(captionStyleFor(packs)).toEqual({ style: DEFAULT_CAPTION_STYLE, ref: 'mine/x' })
  })
})
