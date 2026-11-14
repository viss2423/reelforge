/**
 * `reframe` job: find the primary subject of a (typically landscape) video and return a
 * smooth horizontal path for the 9:16 crop — `{ t: source us, x: 0..1 of source width }` at
 * the detector sample rate, consumed by core's `applyReframe`.
 *
 * FFmpeg samples frames (default 5 fps, 320 px wide) → YuNet (onnxruntime) → tracking,
 * subject choice and a cinematic virtual camera (camera.ts). Cached shot cuts on the asset
 * (from the `scenes` job) make the camera cut instead of pan across shot changes.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DataPaths, JobDefinition } from '../../contracts.ts'
import { resolveAsset } from '../media.ts'
import { parsePayload, ReframePayloadSchema } from '../payloads.ts'
import { throwIfAborted } from '../proc.ts'
import { planCamera, type FrameFaces, type PathPoint } from './camera.ts'
import { YunetDetector, type DetectorOptions, type ExecutionProvider } from './detector.ts'
import { streamFrames } from './frames.ts'

export const DEFAULT_FPS = 5
export const DETECT_WIDTH = 320

export interface ReframeResult {
  path: PathPoint[]
  /** Distinct persistent faces seen (0 → the path is centred). */
  facesFound: number
  /** Fraction of samples in which the subject was detected. */
  coverage: number
  provider: ExecutionProvider
  /** Detector throughput (sampled frames per second of wall time). */
  analysisFps: number
}

/** Location of the YuNet model installed by `pnpm bootstrap`. */
export const faceModelPath = (paths: DataPaths): string =>
  path.join(paths.models, 'face', 'yunet.onnx')

export interface AnalyzeOptions extends DetectorOptions {
  ffmpeg: string
  file: string
  model: string
  fps?: number
  width?: number
  /** Shot cuts (source us). */
  cuts?: readonly number[]
  signal?: AbortSignal
  onTime?: (us: number) => void
}

/** Run detection over a whole file and plan the camera path. */
export const analyzeReframe = async (o: AnalyzeOptions): Promise<ReframeResult> => {
  const detector = await YunetDetector.create(o.model, o)
  const fps = o.fps ?? DEFAULT_FPS
  const frames: FrameFaces[] = []
  let frameW = 0
  let frameH = 0
  const started = performance.now()
  await streamFrames({
    ffmpeg: o.ffmpeg,
    file: o.file,
    fps,
    width: o.width ?? DETECT_WIDTH,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onTime ? { onTime: o.onTime } : {}),
    onFrame: async (f) => {
      throwIfAborted(o.signal)
      frameW = f.width
      frameH = f.height
      const faces = await detector.detect(f.data, f.width, f.height)
      frames.push({ t: Math.round((f.index * 1_000_000) / fps), faces })
    },
  })
  const seconds = (performance.now() - started) / 1000
  const plan = planCamera(frames, {
    frameWidth: frameW || 1,
    frameHeight: frameH || 1,
    ...(o.cuts ? { cuts: o.cuts } : {}),
  })
  return {
    ...plan,
    provider: detector.provider,
    analysisFps: Math.round((frames.length / Math.max(seconds, 1e-3)) * 10) / 10,
  }
}

export const reframeJob: JobDefinition = {
  kind: 'reframe',
  resource: 'ai',
  defaultPriority: 40,
  handler: async (ctx): Promise<ReframeResult> => {
    const opts = parsePayload(ReframePayloadSchema, ctx.payload)
    const { asset, file } = resolveAsset(ctx, opts.assetId)
    if (asset.kind !== 'video') throw new Error('auto-reframe needs a video asset')
    const model = faceModelPath(ctx.paths)
    if (!existsSync(model)) throw new Error('face model is not installed — run `pnpm bootstrap`')
    const total = asset.duration ?? 0
    ctx.progress(0, 'Finding faces')
    const result = await analyzeReframe({
      ffmpeg: ctx.tools.ffmpeg,
      file,
      model,
      signal: ctx.signal,
      ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(asset.scenes ? { cuts: asset.scenes } : {}),
      onTime: (t) => {
        if (total > 0) ctx.progress(Math.min(0.99, t / total), 'Finding faces')
      },
    })
    ctx.progress(
      1,
      result.facesFound > 0
        ? `Tracking ${result.facesFound === 1 ? '1 face' : `${result.facesFound} faces`}`
        : 'No faces — centred',
    )
    return result
  },
}
