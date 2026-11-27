/**
 * `beats` job: FFmpeg → 22.05 kHz mono float PCM pipe → worker thread, then either
 *
 * - **neural** (default when the model is installed): the worker computes Beat This!'s
 *   log-mel spectrogram while FFmpeg decodes, and the network (onnxruntime) marks beats and
 *   downbeats — see neural.ts and the benchmark in ../README.md; or
 * - **dsp** (fallback): spectral flux + tempo autocorrelation + Ellis DP (tracker.ts).
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import * as ort from 'onnxruntime-node'
import type { DataPaths, JobDefinition } from '../../contracts.ts'
import { readMediaInfo } from '../../media/probe.ts'
import { cacheOnAsset, resolveAsset, streamPcm } from '../media.ts'
import { withSession, type ExecutionProvider } from '../onnx.ts'
import { BeatsPayloadSchema, parsePayload } from '../payloads.ts'
import { CancelledError } from '../proc.ts'
import { MEL_BANDS, MEL_SAMPLE_RATE, parseFilterbank } from './mel.ts'
import { inferBeats } from './neural.ts'
import { BEAT_SAMPLE_RATE, type BeatResult } from './tracker.ts'
import type { BeatWorkerIn, BeatWorkerOut } from './worker.ts'

export type BeatEngine = 'neural' | 'dsp'

export interface BeatAnalysis extends BeatResult {
  engine: BeatEngine
  /** Neural model file name (when `engine` is neural). */
  model?: string
  provider?: ExecutionProvider
}

/** Beat This! files installed by `pnpm bootstrap` (models/beats/). */
export interface NeuralBeatModel {
  /** ONNX network. */
  model: string
  /** Raw float32 [513, 128] mel filterbank. */
  filterbank: string
}

/** Default neural model (small: same accuracy on our benchmark at a fraction of the cost). */
export const BEAT_MODEL = 'beat_this_small0.onnx'
export const BEAT_FILTERBANK = 'beat_this_mel_filterbank.bin'

/** Installed neural model, or undefined (→ DSP fallback). */
export const findBeatModel = (paths: DataPaths, name = BEAT_MODEL): NeuralBeatModel | undefined => {
  const dir = path.join(paths.models, 'beats')
  const model = path.join(dir, name)
  const filterbank = path.join(dir, BEAT_FILTERBANK)
  return existsSync(model) && existsSync(filterbank) ? { model, filterbank } : undefined
}

const filterbanks = new Map<string, Promise<Float32Array>>()
const loadFilterbank = (file: string): Promise<Float32Array> => {
  let p = filterbanks.get(file)
  if (!p) {
    p = readFile(file).then(parseFilterbank)
    p.catch(() => filterbanks.delete(file))
    filterbanks.set(file, p)
  }
  return p
}

interface StreamOptions {
  ffmpeg: string
  file: string
  signal?: AbortSignal
  onTime?: (us: number) => void
  /** Source channel count (mean downmix when > 1). */
  channels?: number
  /** Sees every decoded chunk (mono, 22.05 kHz) before it moves to the worker. */
  tap?: (samples: Float32Array) => void
}

/** Decode into the beat worker; resolves with the worker's final message. */
const runWorker = async (
  o: StreamOptions & { sampleRate: number; init?: BeatWorkerIn },
): Promise<Exclude<BeatWorkerOut, { type: 'error' }>> => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url))
  const done = new Promise<Exclude<BeatWorkerOut, { type: 'error' }>>((resolve, reject) => {
    worker.on('message', (msg: BeatWorkerOut) => {
      if (msg.type === 'error') reject(new Error(`beat analysis failed: ${msg.message}`))
      else resolve(msg)
    })
    worker.once('error', reject)
    worker.once('exit', (code) => reject(new Error(`beat worker exited (${code})`)))
  })
  // Avoid an unhandled rejection if decoding fails before we await `done`.
  done.catch(() => undefined)
  try {
    if (o.init) worker.postMessage(o.init)
    await streamPcm({
      ffmpeg: o.ffmpeg,
      file: o.file,
      sampleRate: o.sampleRate,
      ...(o.channels ? { channels: o.channels } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onTime ? { onTime: o.onTime } : {}),
      onSamples: (data) => {
        o.tap?.(data)
        const msg: BeatWorkerIn = { type: 'samples', data }
        worker.postMessage(msg, [data.buffer])
      },
    })
    const end: BeatWorkerIn = { type: 'end' }
    worker.postMessage(end)
    const onAbort = (): void => void worker.terminate()
    o.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await done
      if (o.signal?.aborted) throw new CancelledError()
      return result
    } catch (err) {
      if (o.signal?.aborted) throw new CancelledError()
      throw err
    } finally {
      o.signal?.removeEventListener('abort', onAbort)
    }
  } finally {
    await worker.terminate()
  }
}

/**
 * Analyse a media file's audio for tempo, beats and downbeats with the DSP tracker.
 * Decoding and DSP overlap: chunks reach the worker as soon as FFmpeg produces them.
 */
export const analyzeBeats = async (opts: StreamOptions): Promise<BeatResult> => {
  const out = await runWorker({ ...opts, sampleRate: BEAT_SAMPLE_RATE })
  if (out.type !== 'result') throw new Error('beat worker returned no result')
  return out.result
}

/** Neural analysis: log-mel in the worker during decode, then Beat This! window by window. */
export const analyzeBeatsNeural = async (
  opts: StreamOptions & {
    model: NeuralBeatModel
    provider?: ExecutionProvider
    /** Inference progress 0..1 (after decoding). */
    onInfer?: (fraction: number) => void
    /** Windows run in parallel (default 2). */
    concurrency?: number
  },
): Promise<BeatAnalysis> => {
  const filterbank = (await loadFilterbank(opts.model.filterbank)).slice()
  const out = await runWorker({
    ...opts,
    sampleRate: MEL_SAMPLE_RATE,
    init: { type: 'mel', filterbank },
  })
  if (out.type !== 'spect') throw new Error('beat worker returned no spectrogram')
  return withSession(
    opts.model.model,
    { provider: opts.provider ?? 'cpu' },
    async (session, provider) => {
      const input = session.inputNames[0] ?? 'spectrogram'
      // Static exports take exactly one fixed-length window: zero-pad short ones.
      const meta = session.inputMetadata[0]
      const dim = meta?.isTensor ? meta.shape[1] : undefined
      const fixed = typeof dim === 'number' && dim > 0 ? dim : undefined
      const result = await inferBeats(
        out.spect,
        async (window, length) => {
          let data = window
          if (fixed && length < fixed) {
            data = new Float32Array(fixed * MEL_BANDS)
            data.set(window)
          }
          const r = await session.run({
            [input]: new ort.Tensor('float32', data, [1, fixed ?? length, MEL_BANDS]),
          })
          const beat = r.beat?.data
          const downbeat = r.downbeat?.data
          if (!(beat instanceof Float32Array) || !(downbeat instanceof Float32Array)) {
            throw new Error('beat model returned unexpected outputs')
          }
          // Copy before disposing: the tensors' memory is reused by the next run.
          const copy = { beat: beat.slice(0, length), downbeat: downbeat.slice(0, length) }
          for (const t of Object.values(r)) t.dispose()
          return copy
        },
        {
          concurrency: opts.concurrency ?? 2,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onInfer ? { onProgress: opts.onInfer } : {}),
        },
      )
      if (opts.signal?.aborted) throw new CancelledError()
      return { ...result, engine: 'neural', model: path.basename(opts.model.model), provider }
    },
  )
}

export const beatsJob: JobDefinition = {
  kind: 'beats',
  resource: 'cpu',
  defaultPriority: 30,
  handler: async (ctx): Promise<BeatAnalysis> => {
    const opts = parsePayload(BeatsPayloadSchema, ctx.payload)
    const { asset, file } = resolveAsset(ctx, opts.assetId)
    if (asset.kind === 'image') throw new Error('images have no audio')
    const total = asset.duration ?? 0
    const model = opts.engine === 'dsp' ? undefined : findBeatModel(ctx.paths)
    if (opts.engine === 'neural' && !model) {
      throw new Error('the neural beat model is not installed — run `pnpm bootstrap`')
    }
    const channels = await readMediaInfo(ctx.paths, asset.id).then(
      (i) => i.audioChannels,
      () => undefined,
    )
    // Decoding is ~70 % of the neural pipeline's wall time, inference the rest.
    const decodeShare = model ? 0.7 : 0.95
    ctx.progress(0, 'Detecting beats')
    const common = {
      ffmpeg: ctx.tools.ffmpeg,
      file,
      signal: ctx.signal,
      ...(channels ? { channels } : {}),
      onTime: (t: number) => {
        if (total > 0)
          ctx.progress(Math.min(decodeShare, (decodeShare * t) / total), 'Detecting beats')
      },
    }
    const result: BeatAnalysis = model
      ? await analyzeBeatsNeural({
          ...common,
          model,
          onInfer: (f) => ctx.progress(decodeShare + (0.99 - decodeShare) * f, 'Finding the beat'),
        })
      : { ...(await analyzeBeats(common)), engine: 'dsp' }
    cacheOnAsset(ctx, asset.id, { beats: result.beats, downbeats: result.downbeats })
    ctx.progress(
      1,
      result.bpm ? `${result.bpm.toFixed(1)} BPM · ${result.beats.length} beats` : 'No beat found',
    )
    return result
  },
}
