/**
 * LLM-backed jobs (resource class `ai`, so they never run alongside whisper or the face
 * tracker, and the LLM is unloaded before those start — see `exclusiveAi` in index.ts).
 *
 * | kind       | payload                                        | result            |
 * | ---------- | ---------------------------------------------- | ----------------- |
 * | highlights | { sources[], target, vibe?, topic? }           | HighlightsResult  |
 * | copywriter | { assetIds[], language?, vibe?, topic? }       | CopyResult        |
 * | emphasis   | { words[], language?, chapters? }              | EmphasisResult    |
 *
 * `highlights` works without the LLM (heuristic ranker); the other two need it.
 */
import { z } from 'zod'
import type { JobContext, JobDefinition } from '../../contracts.ts'
import { parsePayload } from '../payloads.ts'
import { writeCopy } from './copywriter.ts'
import { computeEmphasis } from './emphasis.ts'
import { computeHighlights } from './highlights.ts'
import type { SourceInput } from './segments.ts'
import { LlmUnavailableError, type LlmPort } from './types.ts'
import { assetVisualStats } from './visual.ts'

const AssetId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid assetId')
const Us = z.number().int().nonnegative()
const Language = z
  .string()
  .regex(/^(auto|[a-z]{2,3})$/)
  .optional()
const ShortText = z.string().trim().max(80).optional()

export const HighlightsPayloadSchema = z.object({
  sources: z
    .array(z.object({ assetId: AssetId, start: Us.optional(), end: Us.optional() }))
    .min(1)
    .max(60),
  /** Target reel length (µs), 5 s … 3 min. */
  target: Us.min(5_000_000).max(180_000_000),
  vibe: ShortText,
  topic: ShortText,
  /** false → heuristic ranking even when the LLM is installed. */
  useLlm: z.boolean().optional(),
})

export const CopywriterPayloadSchema = z.object({
  assetIds: z.array(AssetId).max(60).default([]),
  language: Language,
  vibe: ShortText,
  topic: ShortText,
})

export const EmphasisPayloadSchema = z.object({
  words: z.array(z.string().max(60)).min(1).max(6000),
  language: Language,
  chapters: z.boolean().optional(),
})

/** Resolves the LLM for a job (the shared, lazily started instance in production). */
export type LlmResolver = (ctx: JobContext) => LlmPort

const requireLlm = async (llm: LlmPort): Promise<LlmPort> => {
  if (!(await llm.available())) throw new LlmUnavailableError()
  return llm
}

/** Builds the per-source inputs from cached analysis on the assets. */
const loadSources = async (
  ctx: JobContext,
  sources: z.infer<typeof HighlightsPayloadSchema>['sources'],
): Promise<SourceInput[]> => {
  const visualCache = new Map<string, Awaited<ReturnType<typeof assetVisualStats>>>()
  const out: SourceInput[] = []
  for (const s of sources) {
    const asset = ctx.store.getAsset(s.assetId)
    if (!asset) throw new Error(`asset ${s.assetId} not found`)
    if (asset.kind === 'audio') continue
    if (!visualCache.has(asset.id))
      visualCache.set(
        asset.id,
        await assetVisualStats(ctx.tools.ffmpeg, ctx.paths, asset, ctx.signal).catch(
          () => undefined,
        ),
      )
    const visual = visualCache.get(asset.id)
    const dur = asset.duration ?? 0
    const start = Math.min(s.start ?? 0, dur)
    const end = Math.min(s.end ?? dur, dur || Number.MAX_SAFE_INTEGER)
    out.push({
      assetId: asset.id,
      kind: asset.kind === 'image' ? 'image' : 'video',
      start,
      end: Math.max(start, end),
      ...(asset.transcript ? { words: asset.transcript } : {}),
      ...(asset.scenes ? { scenes: asset.scenes } : {}),
      ...(visual ? { visual } : {}),
    })
  }
  if (!out.length) throw new Error('Add video clips or photos to cut a reel from')
  return out
}

export const createLlmJobs = (llmOf: LlmResolver): JobDefinition[] => [
  {
    kind: 'highlights',
    resource: 'ai',
    defaultPriority: 35,
    handler: async (ctx) => {
      const o = parsePayload(HighlightsPayloadSchema, ctx.payload)
      ctx.progress(0.02, 'Reading the footage')
      const sources = await loadSources(ctx, o.sources)
      const llm = o.useLlm === false ? undefined : llmOf(ctx)
      const smart = llm ? await llm.available() : false
      ctx.progress(0.1, smart ? 'Finding the best moments (AI)' : 'Finding the best moments')
      const result = await computeHighlights({
        sources,
        target: o.target,
        ...(o.vibe ? { vibe: o.vibe } : {}),
        ...(o.topic ? { topic: o.topic } : {}),
        ...(smart && llm ? { llm } : {}),
        signal: ctx.signal,
      })
      ctx.progress(1, `${result.variants[0]?.moments.length ?? 0} moments`)
      return result
    },
  },
  {
    kind: 'copywriter',
    resource: 'ai',
    defaultPriority: 35,
    handler: async (ctx) => {
      const o = parsePayload(CopywriterPayloadSchema, ctx.payload)
      const llm = await requireLlm(llmOf(ctx))
      const assets = o.assetIds.map((id) => ctx.store.getAsset(id)).filter((a) => a !== undefined)
      const transcript = assets
        .map((a) => (a.transcript ?? []).map((w) => w.text.trim()).join(' '))
        .filter(Boolean)
        .join('\n')
      ctx.progress(0.1, 'Writing hooks and caption')
      const result = await writeCopy({
        llm,
        ...(transcript ? { transcript } : {}),
        ...(o.language && o.language !== 'auto' ? { language: o.language } : {}),
        ...(o.vibe ? { vibe: o.vibe } : {}),
        ...(o.topic ? { topic: o.topic } : {}),
        names: assets.map((a) => a.name.replace(/\.[^.]+$/, '')),
        signal: ctx.signal,
      })
      ctx.progress(1, 'Copy ready')
      return result
    },
  },
  {
    kind: 'emphasis',
    resource: 'ai',
    defaultPriority: 35,
    handler: async (ctx) => {
      const o = parsePayload(EmphasisPayloadSchema, ctx.payload)
      const llm = await requireLlm(llmOf(ctx))
      ctx.progress(0.05, 'Choosing key words')
      const result = await computeEmphasis({
        llm,
        words: o.words,
        ...(o.language && o.language !== 'auto' ? { language: o.language } : {}),
        ...(o.chapters !== undefined ? { chapters: o.chapters } : {}),
        signal: ctx.signal,
        onProgress: (p) => ctx.progress(0.05 + 0.93 * p, 'Choosing key words'),
      })
      ctx.progress(1, `${result.marks.length} key words`)
      return result
    },
  },
]
