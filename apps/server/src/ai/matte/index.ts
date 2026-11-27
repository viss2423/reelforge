/**
 * `matte` job: per-frame subject matte of a video or image asset, for AI background
 * removal/replacement and "text behind subject".
 *
 * FFmpeg decodes the original at the source frame rate, rotation applied, scaled to the
 * matte size (long side ≤ MATTE_MAX_LONG_SIDE) → matting network (onnxruntime-node,
 * DirectML on Windows) → temporal smoothing + guided-filter edge refinement (refine.ts) →
 * one FFmpeg encode writing the lossless export matte and the preview mask proxy
 * (writer.ts). Decode, inference and encode overlap with bounded queues.
 *
 * Cached per asset + model on `asset.matte`; a rerun with the same model is a no-op unless
 * `force`. Files are written to temp names and renamed when complete, so a cancelled or
 * failed job never leaves a half matte behind (the previous one stays valid).
 */
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Asset, AssetMatte } from '@reelforge/core'
import type { DataPaths, JobContext, JobDefinition } from '../../contracts.ts'
import { assetDir } from '../../paths.ts'
import { cacheOnAsset, resolveAsset } from '../media.ts'
import { MattePayloadSchema, parsePayload } from '../payloads.ts'
import { throwIfAborted } from '../proc.ts'
import { streamFrames } from '../reframe/frames.ts'
import { toGray8 } from './image.ts'
import { MATTE_MODELS, matteModelPath, type MatteModelId } from './models.ts'
import { refineMatte, type RefineState } from './refine.ts'
import { Segmenter, type MatteProvider } from './segmenter.ts'
import { openMatteWriter } from './writer.ts'

/** Long side of the stored matte (px). Export upsamples it with the frame; see README. */
export const MATTE_MAX_LONG_SIDE = 1280
/** Frame-rate cap: above it, masks are computed at this rate and held. */
export const MATTE_MAX_FPS = 60
/** Default model (fastest one that measured good enough; see README.md). */
export const DEFAULT_MATTE_MODEL: MatteModelId = 'modnet'

export const matteFile = (paths: DataPaths, assetId: string): string =>
  path.join(assetDir(paths, assetId), 'matte.mkv')

/** Preview mask: H.264 for videos, PNG for stills. */
export const matteProxyFile = (paths: DataPaths, asset: Pick<Asset, 'id' | 'kind'>): string =>
  path.join(
    assetDir(paths, asset.id),
    asset.kind === 'image' ? 'matte-proxy.png' : 'matte-proxy.mp4',
  )

/** Path of a ready matte for the compiler (`CompileContext.resolveMatte`). */
export const readyMatte = (paths: DataPaths, asset: Asset | undefined): string | undefined => {
  if (asset?.matte?.status !== 'ready') return undefined
  const f = matteFile(paths, asset.id)
  return existsSync(f) ? f : undefined
}

export interface MatteResult {
  model: MatteModelId
  /** Execution provider used (absent for a cache hit). */
  provider?: MatteProvider
  frames: number
  width: number
  height: number
  fps: number
  /** Matted frames per second of wall time (decode + inference + refine + encode). */
  fpsProcessed: number
  cached: boolean
}

/** Display (rotation-applied) size of an asset. */
const displaySize = (a: Asset): { width: number; height: number } | undefined => {
  if (!a.width || !a.height) return undefined
  return Math.round((a.rotation ?? 0) / 90) % 2 !== 0
    ? { width: a.height, height: a.width }
    : { width: a.width, height: a.height }
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Matte size for a display size: long side ≤ MATTE_MAX_LONG_SIDE, even dimensions. */
export const matteSize = (w: number, h: number): { width: number; height: number } => {
  const s = Math.min(1, MATTE_MAX_LONG_SIDE / Math.max(w, h))
  return { width: even(w * s), height: even(h * s) }
}

export interface ComputeMatteOptions {
  ffmpeg: string
  ffprobe?: string
  file: string
  modelFile: string
  model: MatteModelId
  provider?: 'auto' | MatteProvider
  width: number
  fps: number
  still: boolean
  output: string
  proxy: string
  signal?: AbortSignal
  onTime?: (us: number) => void
}

/** Decode → segment → refine → encode. Writes `output` and `proxy` (callers rename). */
export const computeMatte = async (
  o: ComputeMatteOptions,
): Promise<Omit<MatteResult, 'cached' | 'model'> & { model: MatteModelId }> => {
  const seg = await Segmenter.create(
    MATTE_MODELS[o.model],
    o.modelFile,
    o.provider ? { provider: o.provider } : {},
  )
  const state: RefineState = { prev: undefined }
  let writer: ReturnType<typeof openMatteWriter> | undefined
  /** Two alpha planes: frame N is segmented while frame N-1 is refined and written. */
  let planes: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)]
  /** Refine + encode of the previous frame, run while the network works on the next one. */
  let post: (() => Promise<void>) | undefined
  let frames = 0
  let w = 0
  let h = 0
  const started = performance.now()
  try {
    await streamFrames({
      ffmpeg: o.ffmpeg,
      ...(o.ffprobe ? { ffprobe: o.ffprobe } : {}),
      file: o.file,
      // A still has one frame and no rate: the fps filter would drop it.
      fps: o.still ? 0 : o.fps,
      width: o.width,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onTime ? { onTime: o.onTime } : {}),
      onFrame: async (f) => {
        throwIfAborted(o.signal)
        if (!writer) {
          w = f.width
          h = f.height
          planes = [new Float32Array(w * h), new Float32Array(w * h)]
          writer = openMatteWriter({
            ffmpeg: o.ffmpeg,
            width: w,
            height: h,
            fps: String(o.fps),
            output: o.output,
            proxy: o.proxy,
            still: o.still,
            ...(o.signal ? { signal: o.signal } : {}),
          })
        }
        if (o.still && frames > 0) return
        const out = writer
        const alpha = planes[frames % 2]!
        // The network runs on a native thread (GPU or intra-op pool): the previous frame's
        // JS-side refinement and encode overlap with it.
        const inference = seg.run(f.data, w, h, w, h, alpha)
        await post?.()
        await inference
        post = async () => {
          refineMatte(alpha, f.data, w, h, state)
          // A fresh buffer per frame: the pipe may hold it until FFmpeg has read it.
          const gray = new Uint8Array(w * h)
          toGray8(alpha, gray)
          await out.write(gray)
        }
        frames++
      },
    })
    await post?.()
    if (!writer || frames === 0) throw new Error('no video frames decoded')
    await writer.end()
  } catch (err) {
    writer?.abort()
    throw err
  } finally {
    seg.close()
  }
  const secs = (performance.now() - started) / 1000
  return {
    model: o.model,
    provider: seg.provider,
    frames,
    width: w,
    height: h,
    fps: o.fps,
    fpsProcessed: Math.round((frames / Math.max(secs, 1e-3)) * 10) / 10,
  }
}

const setMatte = (ctx: JobContext, assetId: string, matte: AssetMatte | undefined): void => {
  // `undefined` restores "no matte"; patchAsset ignores missing keys, so pass it explicitly.
  cacheOnAsset(ctx, assetId, { matte } as Partial<Asset>)
}

export const matteJob: JobDefinition = {
  kind: 'matte',
  resource: 'ai',
  defaultPriority: 40,
  handler: async (ctx): Promise<MatteResult> => {
    const opts = parsePayload(MattePayloadSchema, ctx.payload)
    const { asset, file } = resolveAsset(ctx, opts.assetId)
    if (asset.kind === 'audio') throw new Error('background removal needs a video or image')
    const model = opts.model ?? DEFAULT_MATTE_MODEL
    const modelFile = matteModelPath(ctx.paths, model)
    if (!existsSync(modelFile))
      throw new Error(
        `${MATTE_MODELS[model].label} model is not installed — run \`pnpm bootstrap\``,
      )
    const out = matteFile(ctx.paths, asset.id)
    const proxy = matteProxyFile(ctx.paths, asset)
    const prev = asset.matte
    if (
      !opts.force &&
      prev?.status === 'ready' &&
      prev.model === model &&
      existsSync(out) &&
      existsSync(proxy)
    ) {
      ctx.progress(1, 'Background already separated')
      return {
        model,
        frames: 0,
        width: prev.width ?? 0,
        height: prev.height ?? 0,
        fps: prev.fps ?? 0,
        fpsProcessed: 0,
        cached: true,
      }
    }
    const disp = displaySize(asset) ?? { width: 1080, height: 1920 }
    const size = matteSize(disp.width, disp.height)
    const still = asset.kind === 'image'
    const fps = still ? 1 : Math.min(MATTE_MAX_FPS, Math.round((asset.fps ?? 30) * 1000) / 1000)
    const total = asset.duration ?? 0
    const version = (prev?.version ?? 0) + 1
    setMatte(ctx, asset.id, { status: 'processing', model, version: prev?.version ?? 0 })
    const tmpOut = `${out}.part.mkv`
    const tmpProxy = `${proxy}.part${path.extname(proxy)}`
    ctx.progress(0, 'Loading model')
    try {
      const r = await computeMatte({
        ffmpeg: ctx.tools.ffmpeg,
        ffprobe: ctx.tools.ffprobe,
        file,
        modelFile,
        model,
        ...(opts.provider ? { provider: opts.provider } : {}),
        width: size.width,
        fps,
        still,
        output: tmpOut,
        proxy: tmpProxy,
        signal: ctx.signal,
        onTime: (t) => {
          if (total > 0) ctx.progress(Math.min(0.99, t / total), 'Separating subject')
        },
      })
      await rename(tmpOut, out)
      await rename(tmpProxy, proxy)
      setMatte(ctx, asset.id, {
        status: 'ready',
        model,
        width: r.width,
        height: r.height,
        fps,
        version,
      })
      ctx.progress(1, `Subject separated (${r.fpsProcessed} fps)`)
      return { ...r, cached: false }
    } catch (err) {
      await Promise.all([rm(tmpOut, { force: true }), rm(tmpProxy, { force: true })])
      // Keep a previous good matte usable; otherwise record the failure.
      const keep = prev?.status === 'ready' && existsSync(out) ? prev : undefined
      setMatte(
        ctx,
        asset.id,
        keep ??
          (ctx.signal.aborted
            ? undefined
            : { status: 'failed', model, version: prev?.version ?? 0 }),
      )
      throw err
    }
  },
}
