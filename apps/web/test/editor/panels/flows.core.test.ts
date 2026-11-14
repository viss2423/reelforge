/**
 * Key panel flows against the REAL core ops (no fakes): speed, remove silences, captions,
 * beat sync, scene split, magic edit and layer moves. The AI host is faked (jobs finish
 * immediately with fixed results); everything from the job result to the project mutation
 * runs production code, and every resulting project must pass core's validator.
 */
import {
  sec,
  validateProject,
  type AudioClip,
  type Job,
  type MediaClip,
  type Project,
} from '@reelforge/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyCutPlan,
  autoCaptions,
  beatSync,
  magicEdit,
  planSilence,
  splitScenes,
  type FlowContext,
} from '@/editor/panels/ai/flows.ts'
import type { JobDeps, JobInput } from '@/editor/panels/ai/jobs.ts'
import { DEFAULT_CAPTION_STYLE } from '@/editor/panels/ai/launch.ts'
import { moveLayer, setSpeed, setSpeedCurve } from '@/editor/panels/model/edits.ts'
import type { EditorStoreApi } from '@/state/editorStore.ts'
import { clipIn, makeJob, richStore } from './helpers.ts'

vi.mock('@/components/Toast.tsx', () => ({
  toast: Object.assign(vi.fn<(title: string) => number>(), {
    error: vi.fn<(title: string, description?: string) => number>(),
  }),
}))

const word = (text: string, start: number, end: number) => ({
  text,
  start,
  end,
  confidence: 1,
  filler: text === 'um',
  emphasis: false,
})

const RESULTS: Partial<Record<Job['kind'], (assetId: string) => unknown>> = {
  silence: () => ({ ranges: [{ start: sec(0.5), end: sec(1) }] }),
  transcribe: () => ({
    words: [
      word('hello', 0, sec(0.4)),
      word('um', sec(1.2), sec(1.4)),
      word('world', sec(1.5), sec(1.9)),
    ],
  }),
  beats: () => ({ beats: [0, sec(1), sec(2), sec(3), sec(4)], bpm: 60 }),
  scenes: () => ({ scenes: [sec(1)] }),
}

const host = (): JobDeps => {
  let n = 0
  return {
    api: {
      createJob: async (input: JobInput) =>
        makeJob({
          id: `j${++n}`,
          kind: input.kind,
          status: 'done',
          progress: 1,
          result: RESULTS[input.kind]?.(input.assetId ?? ''),
        }),
      job: async (id: string) => makeJob({ id, status: 'running' }),
      cancelJob: async () => undefined,
    },
    events: { on: () => () => undefined },
    pollMs: 60_000,
  }
}

let store: EditorStoreApi
const s = () => store.getState()
const project = (): Project => s().project!
const ctx = (): FlowContext => ({
  store,
  jobs: host(),
  signal: new AbortController().signal,
  report: () => undefined,
})
const valid = () => expect(validateProject(project())).toEqual([])
const mainClips = () => project().tracks.find((t) => t.kind === 'main')!.clips as MediaClip[]

beforeEach(() => {
  store = richStore()
})

describe('panel flows on real core ops', () => {
  it('speed: changes duration, keeps the main track gapless, curves ramp', () => {
    s().dispatch('Speed', (d) => setSpeed(d, 'v1', 2))
    expect(clipIn<MediaClip>(store, 'v1').duration).toBe(sec(1))
    expect(mainClips().map((c) => c.start)).toEqual([0, sec(1)])
    valid()
    s().dispatch('Curve', (d) => setSpeedCurve(d, 'v2', 'montage'))
    expect(clipIn<MediaClip>(store, 'v2').speedRamp?.length).toBeGreaterThan(1)
    valid()
    s().undo()
    s().undo()
    expect(clipIn<MediaClip>(store, 'v1').duration).toBe(sec(2))
  })

  it('remove silences: cuts source ranges from every clip of the asset', async () => {
    const plan = await planSilence(ctx())
    const stats = applyCutPlan(store, plan, 'Remove silences')
    expect(stats.count).toBe(2)
    // v1 shows a1 [0,2s) and v2 shows a2 [0,3s): each loses [0.5s,1s) and splits around it.
    expect(mainClips().reduce((t, c) => t + c.duration, 0)).toBe(sec(4))
    expect(mainClips()).toHaveLength(4)
    valid()
    s().undo()
    expect(mainClips().map((c) => c.id)).toEqual(['v1', 'v2'])
  })

  it('captions: builds caption words on playback time with the chosen style', async () => {
    const words = await autoCaptions(ctx(), {
      style: DEFAULT_CAPTION_STYLE,
      styleRef: 'trend/hormozi',
      language: 'auto',
    })
    expect(words).toBeGreaterThan(0)
    const captions = project().captions!
    expect(captions.styleRef).toBe('trend/hormozi')
    expect(captions.words.length).toBeGreaterThan(0)
    for (const w of captions.words) expect(w.end).toBeGreaterThanOrEqual(w.start)
    valid()
  })

  it('beat sync: writes beat markers and snaps main-track cuts onto beats', async () => {
    const n = await beatSync(ctx(), { musicClipId: 'mus', every: 1 })
    expect(n).toBeGreaterThan(0)
    expect(project().markers.filter((m) => m.kind === 'beat').length).toBe(n)
    const beats = new Set([0, sec(1), sec(2), sec(3), sec(4)])
    // Every cut between main clips lands on a beat.
    for (const c of mainClips().slice(1)) expect(beats.has(c.start)).toBe(true)
    valid()
  })

  it('scene split: splits main videos at source scene changes', async () => {
    const n = await splitScenes(ctx())
    expect(n).toBeGreaterThan(0)
    expect(mainClips().length).toBe(2 + n)
    valid()
  })

  it('magic edit: silences, fillers, beats and captions as one valid undo step', async () => {
    const before = project()
    const summary = await magicEdit(ctx(), { style: DEFAULT_CAPTION_STYLE, language: 'auto' })
    expect(summary.captionWords).toBeGreaterThan(0)
    valid()
    s().undo()
    expect(project()).toEqual(before)
  })

  it('layer moves never leave empty overlay tracks behind', () => {
    const overlays = () => project().tracks.filter((t) => t.kind === 'overlay').length
    expect(overlays()).toBe(1)
    s().dispatch('Forward', (d) => void moveLayer(d, 'ov1', 'forward'))
    s().dispatch('Forward', (d) => void moveLayer(d, 'stk', 'forward'))
    s().dispatch('Back', (d) => void moveLayer(d, 'ov1', 'backward'))
    s().dispatch('Back', (d) => void moveLayer(d, 'stk', 'backward'))
    const emptyOverlays = project().tracks.filter((t) => t.kind === 'overlay' && !t.clips.length)
    expect(emptyOverlays).toEqual([])
    expect(clipIn<AudioClip>(store, 'mus').start).toBe(0)
    valid()
  })
})
