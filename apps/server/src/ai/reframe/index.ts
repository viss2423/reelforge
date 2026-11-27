/**
 * `reframe` job: find the subject of a (typically landscape) video and return a smooth
 * crop path for the 9:16 frame — `{ t: source us, x: 0..1 of source width, w? }` at the
 * sample rate, consumed by core's `applyReframe`.
 *
 * Two modes, chosen by what `pnpm bootstrap` installed (or the payload):
 *
 * - **smart** (default): D-FINE person/object detection + YuNet faces + mouth activity and
 *   speech energy for the active speaker, U²-Netp saliency for shots with nobody in them,
 *   group framing with zoom-out. Samples at 3 fps, 640 px wide (planner.ts).
 * - **fast** (fallback, or `mode: 'fast'`): YuNet faces only at 5 fps, 320 px wide — the
 *   original path, ~7× realtime.
 *
 * Cached shot cuts on the asset (from the `scenes` job) make the camera cut instead of pan.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as ort from 'onnxruntime-node'
import type { DataPaths, JobDefinition } from '../../contracts.ts'
import { readMediaInfo } from '../../media/probe.ts'
import { resolveAsset, streamPcm } from '../media.ts'
import { withSession } from '../onnx.ts'
import { parsePayload, ReframePayloadSchema } from '../payloads.ts'
import { throwIfAborted } from '../proc.ts'
import { facePatches, RmsEnvelope, speechLevels } from './activity.ts'
import { planCamera, type FrameFaces } from './camera.ts'
import { YunetDetector, type DetectorOptions, type ExecutionProvider } from './detector.ts'
import { streamFrames } from './frames.ts'
import { decodeDetr, PERSON, preprocessDetr, SALIENT_CLASSES } from './objects.ts'
import { planReframe, type FramingMode, type PlannedPoint, type Sample } from './planner.ts'
import { preprocessSaliency, salientBox, SALIENCY_SIZE } from './saliency.ts'

export const DEFAULT_FPS = 5
export const DETECT_WIDTH = 320
/** Smart mode: sample rate, frame width and the detector's square input size. */
export const SMART_FPS = 3
export const SMART_WIDTH = 640
export const OBJECT_SIZE = 480
export const OBJECT_THRESHOLD = 0.4

export type ReframeMode = 'smart' | 'fast'

export interface ReframeResult {
  path: PlannedPoint[]
  /** Distinct persistent faces seen (0 → the path is centred). */
  facesFound: number
  /** Distinct persistent people or faces (smart mode). */
  subjects: number
  /** Fraction of samples in which the subject was detected. */
  coverage: number
  provider: ExecutionProvider
  /** Detector throughput (sampled frames per second of wall time). */
  analysisFps: number
  mode: ReframeMode
  /** Samples per framing mode (smart mode). */
  framing?: Record<FramingMode, number>
}

/** Models installed by `pnpm bootstrap`. */
export interface ReframeModels {
  face: string
  /** D-FINE person/object detector (smart mode). */
  objects?: string
  /** U²-Netp saliency (smart mode). */
  saliency?: string
}

/** Location of the YuNet model installed by `pnpm bootstrap`. */
export const faceModelPath = (paths: DataPaths): string =>
  path.join(paths.models, 'face', 'yunet.onnx')

export const findReframeModels = (paths: DataPaths): ReframeModels | undefined => {
  const face = faceModelPath(paths)
  if (!existsSync(face)) return undefined
  const objects = path.join(paths.models, 'objects', 'dfine_s_coco.onnx')
  const saliency = path.join(paths.models, 'saliency', 'u2netp.onnx')
  return {
    face,
    ...(existsSync(objects) ? { objects } : {}),
    ...(existsSync(saliency) ? { saliency } : {}),
  }
}

export interface AnalyzeOptions extends DetectorOptions {
  ffmpeg: string
  file: string
  /** Face model path. */
  model: string
  /** Smart-mode models (absent → fast mode). */
  models?: ReframeModels
  mode?: ReframeMode
  fps?: number
  width?: number
  /** 0 = calm … 1 = tight camera (default 0.5). */
  strength?: number
  /** Source channel count, for the speech-energy decode. */
  channels?: number
  /** Shot cuts (source us). */
  cuts?: readonly number[]
  signal?: AbortSignal
  onTime?: (us: number) => void
}

/** Run detection over a whole file and plan the camera path. */
export const analyzeReframe = async (o: AnalyzeOptions): Promise<ReframeResult> =>
  o.mode !== 'fast' && o.models?.objects !== undefined ? analyzeSmart(o) : analyzeFast(o)

const analyzeFast = async (o: AnalyzeOptions): Promise<ReframeResult> => {
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
    subjects: plan.facesFound,
    provider: detector.provider,
    analysisFps: Math.round((frames.length / Math.max(seconds, 1e-3)) * 10) / 10,
    mode: 'fast',
  }
}

/** 100 ms speech-energy envelope of the clip's audio (undefined when it has none). */
const speechEnvelope = async (o: AnalyzeOptions): Promise<Float32Array | undefined> => {
  const env = new RmsEnvelope(800)
  try {
    await streamPcm({
      ffmpeg: o.ffmpeg,
      file: o.file,
      sampleRate: 8000,
      ...(o.channels && o.channels > 1 ? { channels: o.channels } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      onSamples: (s) => env.push(s),
    })
  } catch {
    return undefined
  }
  return env.values.length ? speechLevels(env.values) : undefined
}

const analyzeSmart = async (o: AnalyzeOptions): Promise<ReframeResult> => {
  const models = o.models
  if (!models?.objects) throw new Error('smart reframe needs the object model')
  const detector = await YunetDetector.create(o.model, o)
  const fps = o.fps ?? SMART_FPS
  const samples: Sample[] = []
  let frameW = 0
  let frameH = 0
  const started = performance.now()
  // Speech energy is decoded in parallel; only its envelope is needed afterwards.
  const speech = speechEnvelope(o)
  speech.catch(() => undefined)
  const objectInput = new Float32Array(3 * OBJECT_SIZE * OBJECT_SIZE)
  const saliencyInput = new Float32Array(3 * SALIENCY_SIZE * SALIENCY_SIZE)

  const pass = async (
    objects: ort.InferenceSession,
    saliency: ort.InferenceSession | undefined,
  ): Promise<void> => {
    await streamFrames({
      ffmpeg: o.ffmpeg,
      file: o.file,
      fps,
      width: o.width ?? SMART_WIDTH,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onTime ? { onTime: o.onTime } : {}),
      onFrame: async (f) => {
        throwIfAborted(o.signal)
        frameW = f.width
        frameH = f.height
        const faces = (await detector.detect(f.data, f.width, f.height)).map((face) => ({
          ...face,
          ...facePatches(f.data, f.width, f.height, face),
        }))
        preprocessDetr(f.data, f.width, f.height, OBJECT_SIZE, objectInput)
        const r = await objects.run({
          pixel_values: new ort.Tensor('float32', objectInput, [1, 3, OBJECT_SIZE, OBJECT_SIZE]),
        })
        const dets = decodeDetr(
          r.logits?.data as Float32Array,
          r.pred_boxes?.data as Float32Array,
          80,
          f.width,
          f.height,
          OBJECT_THRESHOLD,
        )
        for (const t of Object.values(r)) t.dispose()
        const people = dets.filter((d) => d.label === PERSON)
        const things = dets.filter((d) => SALIENT_CLASSES.has(d.label))
        const sample: Sample = {
          t: Math.round((f.index * 1_000_000) / fps),
          faces,
          people,
          objects: things,
        }
        // Saliency only where nothing else explains the shot.
        if (saliency && people.length === 0 && faces.length === 0 && things.length === 0) {
          preprocessSaliency(f.data, f.width, f.height, saliencyInput)
          const s = await saliency.run({
            [saliency.inputNames[0] ?? 'input']: new ort.Tensor('float32', saliencyInput, [
              1,
              3,
              SALIENCY_SIZE,
              SALIENCY_SIZE,
            ]),
          })
          const first = s[saliency.outputNames[0] ?? '']
          const box = first
            ? salientBox(first.data as Float32Array, SALIENCY_SIZE, f.width, f.height)
            : undefined
          for (const t of Object.values(s)) t.dispose()
          if (box) sample.saliency = box
        }
        samples.push(sample)
      },
    })
  }

  await withSession(models.objects, { provider: 'cpu', threads: 4 }, async (objects) => {
    if (models.saliency) {
      await withSession(models.saliency, { provider: 'cpu', threads: 2 }, (s) => pass(objects, s))
    } else await pass(objects, undefined)
  })
  const levels = await speech
  if (levels) {
    // 100 ms blocks: look up the level at each sample time.
    for (const s of samples) {
      s.speech = levels[Math.min(levels.length - 1, Math.floor(s.t / 100_000))] ?? 0
    }
  }
  const seconds = (performance.now() - started) / 1000
  const plan = planReframe(samples, {
    frameWidth: frameW || 1,
    frameHeight: frameH || 1,
    ...(o.cuts ? { cuts: o.cuts } : {}),
    ...(o.strength !== undefined ? { strength: o.strength } : {}),
  })
  return {
    path: plan.path,
    facesFound: plan.facesFound,
    subjects: plan.subjects,
    coverage: plan.coverage,
    provider: detector.provider,
    analysisFps: Math.round((samples.length / Math.max(seconds, 1e-3)) * 10) / 10,
    mode: 'smart',
    framing: plan.modes,
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
    const models = findReframeModels(ctx.paths)
    if (!models) throw new Error('face model is not installed — run `pnpm bootstrap`')
    const channels = await readMediaInfo(ctx.paths, asset.id).then(
      (i) => i.audioChannels,
      () => undefined,
    )
    const total = asset.duration ?? 0
    ctx.progress(0, 'Finding the subject')
    const result = await analyzeReframe({
      ffmpeg: ctx.tools.ffmpeg,
      file,
      model: models.face,
      models,
      signal: ctx.signal,
      ...(channels ? { channels } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.strength !== undefined ? { strength: opts.strength } : {}),
      ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(asset.scenes ? { cuts: asset.scenes } : {}),
      onTime: (t) => {
        if (total > 0) ctx.progress(Math.min(0.99, t / total), 'Finding the subject')
      },
    })
    const n = result.subjects
    const what = result.mode === 'fast' ? 'face' : 'subject'
    ctx.progress(
      1,
      n > 0
        ? `Tracking ${n === 1 ? `1 ${what}` : `${n} ${what}s`}`
        : `No ${what === 'face' ? 'faces' : 'subject found'} — centred`,
    )
    return result
  },
}
