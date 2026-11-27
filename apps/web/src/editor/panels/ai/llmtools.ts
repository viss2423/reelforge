/**
 * Language-model tools in the AI panel: "Best moments" (auto-cut to a 15/30/60 s reel,
 * reviewed first), "Hook & caption" (copywriter: hook text options to insert, post caption
 * and hashtags to copy) and "Improve captions" (keyword emphasis, emoji, chapters).
 */
import {
  applyCaptionEmphasis,
  assembleAutoEdit,
  OpError,
  type Project,
  type TextPreset,
  type Us,
} from '@reelforge/core'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Packs } from '@/api/schemas.ts'
import { editorStore, type EditorStoreApi } from '@/state/editorStore.ts'
import { catalog } from '../model/catalog.ts'
import { isVideo, mainMediaClips } from '../model/draft.ts'
import { addText } from '../model/edits.ts'
import {
  analyze,
  distinct,
  ensureSameProject,
  projectOf,
  transcribe,
  type FlowContext,
} from './flows.ts'
import { runJobs } from './jobs.ts'
import { readCopy, readEmphasis, readHighlights, readScenes, type Copy } from './results.ts'
import { aiTasks, type AiTasks } from './tasks.ts'

const SEC = 1_000_000

/* ------------------------------------------------------------------ best moments */

/** Transcribes + scene-detects the main track, then asks the host for highlights. */
export const planBestMoments = async (ctx: FlowContext, targetSeconds: number) => {
  const p = projectOf(ctx.store)
  const clips = mainMediaClips(p)
  if (!clips.length) throw new OpError('no_clips', 'Add some clips to the timeline first')
  const assets = ctx.store.getState().assets
  const videos = distinct(clips.filter(isVideo))
  const speech = videos.filter((id) => assets[id]?.hasAudio !== false)
  const label = 'Reading your clips'
  const [words] = await Promise.all([
    speech.length
      ? transcribe(ctx, speech, p.captions?.language ?? 'auto', [0, 0.45])
      : Promise.resolve({ results: {} }),
    videos.length
      ? analyze(
          ctx,
          videos,
          (assetId) => ({ kind: 'scenes', assetId, projectId: p.id, payload: { assetId } }),
          readScenes,
          (a) => a?.scenes,
          label,
          [0, 0.45],
        )
      : Promise.resolve(undefined),
  ])
  ctx.report(0.5, 'Choosing the best moments')
  const [job] = await runJobs(
    ctx.jobs,
    [
      {
        kind: 'highlights',
        projectId: p.id,
        payload: {
          sources: clips.map((c) =>
            c.type === 'image'
              ? { assetId: c.assetId }
              : { assetId: c.assetId, start: c.in, end: c.in + Math.round(c.duration * c.speed) },
          ),
          target: targetSeconds * SEC,
        },
      },
    ],
    {
      signal: ctx.signal,
      onProgress: (v) => ctx.report(0.5 + 0.48 * v, 'Choosing the best moments'),
    },
  )
  return { highlights: readHighlights(job!.result), transcripts: words.results }
}

const fmt = (us: Us): string => `${(us / SEC).toFixed(1)} s`

export const startBestMoments = (targetSeconds: number, tasks: AiTasks = aiTasks): void =>
  tasks.start('highlights', 'Best moments', async (ctx) => {
    const projectId = projectOf(ctx.store).id
    const { highlights, transcripts } = await planBestMoments(ctx, targetSeconds)
    const v = highlights.variants[0]!
    const detail = v.moments
      .map(
        (m, i) =>
          `${i + 1}. ${m.role === 'hook' ? 'Hook — ' : ''}${m.reason || 'strong moment'} (${fmt(m.end - m.start)})`,
      )
      .join('\n')
    return {
      kind: 'review',
      summary: `${v.moments.length} moments · ${fmt(v.duration)}${highlights.ranker === 'llm' ? ' · picked by AI' : ''}`,
      detail,
      apply: () => {
        const n = ensureSameProject(ctx, projectId, () =>
          ctx.store.getState().dispatch('Auto-cut best moments', (d: Project) => {
            const hadCaptions = !!d.captions?.words.length
            return assembleAutoEdit(
              d,
              {
                moments: v.moments,
                ...(hadCaptions && d.captions
                  ? {
                      captions: {
                        transcripts,
                        style: d.captions.style,
                        ...(d.captions.styleRef ? { styleRef: d.captions.styleRef } : {}),
                        language: d.captions.language,
                      },
                    }
                  : {}),
              },
              ctx.store.getState().assets,
            ).clips
          }),
        )
        return `Cut to the ${n} best moments`
      },
    }
  })

/* ------------------------------------------------------------------ copywriter */

export interface CopyState {
  projectId: string
  copy: Copy
}

export const copyResults = createStore<{ current: CopyState | null }>()(() => ({ current: null }))

export const useCopyResult = (projectId: string | undefined): Copy | undefined =>
  useStore(copyResults, (s) => (s.current?.projectId === projectId ? s.current?.copy : undefined))

export const startCopywriter = (tasks: AiTasks = aiTasks): void =>
  tasks.start('copy', 'Hook & caption', async (ctx) => {
    const p = projectOf(ctx.store)
    const assets = ctx.store.getState().assets
    const speech = distinct(mainMediaClips(p).filter(isVideo)).filter(
      (id) => assets[id]?.hasAudio !== false,
    )
    const language = p.captions?.language ?? 'auto'
    const { results } = speech.length
      ? await transcribe(ctx, speech, language, [0, 0.6])
      : { results: {} }
    ctx.report(0.65, 'Writing hooks and caption')
    const [job] = await runJobs(
      ctx.jobs,
      [
        {
          kind: 'copywriter',
          projectId: p.id,
          payload: {
            assetIds: Object.keys(results).length ? speech : distinct(mainMediaClips(p)),
            language,
          },
        },
      ],
      {
        signal: ctx.signal,
        onProgress: (v) => ctx.report(0.65 + 0.33 * v, 'Writing hooks and caption'),
      },
    )
    const copy = readCopy(job!.result)
    copyResults.setState({ current: { projectId: p.id, copy } })
    return { kind: 'done', message: 'Hook ideas, caption and hashtags are ready', undoable: false }
  })

/** Most trending hook text preset. */
export const hookPreset = (
  packs: Packs | undefined,
): { item: TextPreset; ref: string } | undefined => {
  const all = catalog(packs, 'textPresets')
  const hook = all.find((c) => c.item.tags.includes('hook')) ?? all[0]
  return hook ? { item: hook.item, ref: hook.ref } : undefined
}

/** Inserts a hook line as a text clip over the first seconds (one undo step). */
export const insertHookText = (
  text: string,
  packs: Packs | undefined,
  store: EditorStoreApi = editorStore,
): void => {
  store.getState().dispatch('Add hook text', (d: Project) => {
    const clip = addText(d, 0, hookPreset(packs))
    clip.text = text
    clip.transform.y.value = 480
  })
}

/* ------------------------------------------------------------------ captions */

export const startImproveCaptions = (o: { chapters: boolean }, tasks: AiTasks = aiTasks): void =>
  tasks.start('emphasis', 'Improve captions', async (ctx) => {
    const p = projectOf(ctx.store)
    const words = p.captions?.words ?? []
    if (!words.length) throw new OpError('no_captions', 'Generate captions first')
    const texts = words.map((w) => w.text)
    const [job] = await runJobs(
      ctx.jobs,
      [
        {
          kind: 'emphasis',
          projectId: p.id,
          payload: { words: texts, language: p.captions?.language ?? 'auto', chapters: o.chapters },
        },
      ],
      { signal: ctx.signal, onProgress: (v) => ctx.report(v, 'Choosing key words') },
    )
    const em = readEmphasis(job!.result)
    const marks = em.marks
      .filter((m) => texts[m.index] !== undefined)
      .map((m) => ({ ...m, text: texts[m.index]! }))
    const emojis = marks.filter((m) => m.emoji).length
    return {
      kind: 'review',
      summary: [
        `${marks.length} key words`,
        emojis && `${emojis} emoji`,
        em.chapters.length && `${em.chapters.length} chapters`,
      ]
        .filter(Boolean)
        .join(' · '),
      detail: marks
        .slice(0, 12)
        .map((m) => (m.emoji ? `${m.text} ${m.emoji}` : m.text))
        .join(', '),
      apply: () => {
        const n = ensureSameProject(ctx, p.id, () =>
          ctx.store
            .getState()
            .dispatch('Improve captions', (d: Project) =>
              applyCaptionEmphasis(d, marks, em.chapters),
            ),
        )
        return `Highlighted ${n} key words`
      },
    }
  })
