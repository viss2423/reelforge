/**
 * Platform media jobs: probe → (proxy, thumbnails, waveform). Each job updates the asset's
 * state field and emits an `asset` event so every connected device sees progress live.
 */
import { mkdir } from 'node:fs/promises'
import type { Asset } from '@reelforge/core'
import { z } from 'zod'
import type { JobContext, JobDefinition } from '../contracts.ts'
import { assetDir, assetFile } from '../paths.ts'
import { makeProxy } from './proxy.ts'
import {
  assetFieldsFromInfo,
  probeFile,
  readMediaInfo,
  writeMediaInfo,
  type MediaInfo,
} from './probe.ts'
import { makeThumbnails } from './thumbnails.ts'
import { makeWaveform } from './waveform.ts'

/** Scheduling priorities (lower = sooner). Probe/thumbnails/waveform are interactive. */
export const PRIORITY = { probe: 10, thumbnails: 15, waveform: 15, proxy: 20 } as const

const AssetPayload = z.object({ assetId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })

/** Typed helper: definitions are stored as JobDefinition<unknown>; payloads are validated. */
const define = <P>(def: JobDefinition<P>): JobDefinition => def as unknown as JobDefinition

const loadAsset = (ctx: JobContext): Asset => {
  const { assetId } = AssetPayload.parse(ctx.payload)
  const asset = ctx.store.getAsset(assetId)
  if (!asset) throw new Error(`asset not found: ${assetId}`)
  return asset
}

/** Patches the asset (if it still exists) and broadcasts it. */
const update = (ctx: JobContext, id: string, patch: Partial<Asset>): Asset | undefined => {
  if (!ctx.store.getAsset(id)) return undefined
  const asset = ctx.store.patchAsset(id, patch)
  ctx.emit({ type: 'asset', asset })
  return asset
}

/**
 * Runs `work` while keeping an asset state field in sync. On failure the field is set to
 * 'failed' (unless the job was cancelled, e.g. because the asset was deleted).
 */
const tracked = async <T>(
  ctx: JobContext,
  asset: Asset,
  field: 'proxy' | 'thumbnails' | 'waveform',
  work: (info: MediaInfo) => Promise<T>,
): Promise<T> => {
  if (field === 'proxy') update(ctx, asset.id, { proxy: 'processing' })
  try {
    const info = await readMediaInfo(ctx.paths, asset.id)
    const result = await work(info)
    update(ctx, asset.id, { [field]: 'ready' })
    return result
  } catch (err) {
    if (!ctx.signal.aborted) update(ctx, asset.id, { [field]: 'failed' })
    else if (field === 'proxy') update(ctx, asset.id, { proxy: 'pending' })
    throw err
  }
}

const probe = define<{ assetId: string }>({
  kind: 'probe',
  resource: 'io',
  defaultPriority: PRIORITY.probe,
  handler: async (ctx) => {
    const asset = loadAsset(ctx)
    await mkdir(assetDir(ctx.paths, asset.id), { recursive: true })
    let info: MediaInfo
    try {
      info = await probeFile(ctx.tools.ffprobe, assetFile(ctx.paths, asset, 'original'), {
        mime: asset.mime,
        signal: ctx.signal,
      })
    } catch (err) {
      if (!ctx.signal.aborted)
        update(ctx, asset.id, { proxy: 'failed', thumbnails: 'failed', waveform: 'failed' })
      throw err
    }
    await writeMediaInfo(ctx.paths, asset.id, info)
    const needsProxy = info.kind === 'video'
    const needsWaveform = info.hasAudio
    update(ctx, asset.id, {
      ...assetFieldsFromInfo(info),
      proxy: needsProxy ? 'pending' : 'not-needed',
      thumbnails: 'pending',
      waveform: needsWaveform ? 'pending' : 'not-needed',
    })
    const opts = { assetId: asset.id }
    // Thumbnails and waveform first: they are what the timeline shows immediately.
    ctx.enqueue('thumbnails', { assetId: asset.id }, opts)
    if (needsWaveform) ctx.enqueue('waveform', { assetId: asset.id }, opts)
    if (needsProxy) ctx.enqueue('proxy', { assetId: asset.id }, opts)
    return info
  },
})

const proxy = define<{ assetId: string }>({
  kind: 'proxy',
  resource: 'gpu-encode',
  defaultPriority: PRIORITY.proxy,
  handler: async (ctx) => {
    const asset = loadAsset(ctx)
    return tracked(ctx, asset, 'proxy', (info) =>
      makeProxy({
        tools: ctx.tools,
        info,
        input: assetFile(ctx.paths, asset, 'original'),
        output: assetFile(ctx.paths, asset, 'proxy'),
        signal: ctx.signal,
        onProgress: (p, eta) => ctx.progress(p, 'Creating editing proxy', eta),
      }),
    )
  },
})

const thumbnails = define<{ assetId: string }>({
  kind: 'thumbnails',
  resource: 'cpu',
  defaultPriority: PRIORITY.thumbnails,
  handler: async (ctx) => {
    const asset = loadAsset(ctx)
    return tracked(ctx, asset, 'thumbnails', (info) =>
      makeThumbnails({
        tools: ctx.tools,
        info,
        input: assetFile(ctx.paths, asset, 'original'),
        sprite: assetFile(ctx.paths, asset, 'thumbs'),
        index: assetFile(ctx.paths, asset, 'thumbsIndex'),
        poster: assetFile(ctx.paths, asset, 'poster'),
        signal: ctx.signal,
      }),
    )
  },
})

const waveform = define<{ assetId: string }>({
  kind: 'waveform',
  resource: 'cpu',
  defaultPriority: PRIORITY.waveform,
  handler: async (ctx) => {
    const asset = loadAsset(ctx)
    return tracked(ctx, asset, 'waveform', (info) =>
      makeWaveform({
        ffmpeg: ctx.tools.ffmpeg,
        info,
        input: assetFile(ctx.paths, asset, 'original'),
        output: assetFile(ctx.paths, asset, 'waveform'),
        signal: ctx.signal,
      }),
    )
  },
})

/** probe, proxy, thumbnails, waveform. */
export const platformJobs: readonly JobDefinition[] = [probe, proxy, thumbnails, waveform]
