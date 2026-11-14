/** `beats` job: FFmpeg → 22.05 kHz mono float PCM pipe → worker-thread beat tracker. */
import { Worker } from 'node:worker_threads'
import type { JobDefinition } from '../../contracts.ts'
import { cacheOnAsset, resolveAsset, streamPcm } from '../media.ts'
import { BeatsPayloadSchema, parsePayload } from '../payloads.ts'
import { CancelledError } from '../proc.ts'
import { BEAT_SAMPLE_RATE, type BeatResult } from './tracker.ts'
import type { BeatWorkerIn, BeatWorkerOut } from './worker.ts'

/**
 * Analyse a media file's audio for tempo, beats and downbeats. Decoding and DSP overlap:
 * chunks are transferred to the worker as soon as FFmpeg produces them.
 */
export const analyzeBeats = async (opts: {
  ffmpeg: string
  file: string
  signal?: AbortSignal
  onTime?: (us: number) => void
}): Promise<BeatResult> => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url))
  const done = new Promise<BeatResult>((resolve, reject) => {
    worker.on('message', (msg: BeatWorkerOut) => {
      if (msg.type === 'result') resolve(msg.result)
      else reject(new Error(`beat analysis failed: ${msg.message}`))
    })
    worker.once('error', reject)
    worker.once('exit', (code) => reject(new Error(`beat worker exited (${code})`)))
  })
  // Avoid an unhandled rejection if decoding fails before we await `done`.
  done.catch(() => undefined)
  try {
    await streamPcm({
      ffmpeg: opts.ffmpeg,
      file: opts.file,
      sampleRate: BEAT_SAMPLE_RATE,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onTime ? { onTime: opts.onTime } : {}),
      onSamples: (data) => {
        const msg: BeatWorkerIn = { type: 'samples', data }
        worker.postMessage(msg, [data.buffer])
      },
    })
    const end: BeatWorkerIn = { type: 'end' }
    worker.postMessage(end)
    const onAbort = (): void => void worker.terminate()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await done
      if (opts.signal?.aborted) throw new CancelledError()
      return result
    } catch (err) {
      if (opts.signal?.aborted) throw new CancelledError()
      throw err
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  } finally {
    await worker.terminate()
  }
}

export const beatsJob: JobDefinition = {
  kind: 'beats',
  resource: 'cpu',
  defaultPriority: 30,
  handler: async (ctx) => {
    const { assetId } = parsePayload(BeatsPayloadSchema, ctx.payload)
    const { asset, file } = resolveAsset(ctx, assetId)
    if (asset.kind === 'image') throw new Error('images have no audio')
    const total = asset.duration ?? 0
    ctx.progress(0, 'Detecting beats')
    const result = await analyzeBeats({
      ffmpeg: ctx.tools.ffmpeg,
      file,
      signal: ctx.signal,
      onTime: (t) => {
        if (total > 0) ctx.progress(Math.min(0.95, (0.95 * t) / total), 'Detecting beats')
      },
    })
    cacheOnAsset(ctx, asset.id, { beats: result.beats })
    ctx.progress(
      1,
      result.bpm ? `${result.bpm.toFixed(1)} BPM · ${result.beats.length} beats` : 'No beat found',
    )
    return result
  },
}
