/**
 * `transcribe` job: word-level speech recognition with whisper.cpp.
 *
 * Backends (chosen automatically, overridable with `payload.backend`):
 * - `hybrid` (default when FFmpeg has the `whisper` filter): the large model runs through
 *   FFmpeg's GPU-offloaded whisper for the TEXT while, concurrently, a small model runs in
 *   whisper-cli on the CPU with DTW for word TIMING; the two are aligned word-by-word.
 *   On a Ryzen 7 8840U / Radeon 780M this is ~10× faster than large-v3-turbo on the CPU
 *   (see README.md in this directory for the benchmark).
 * - `cli`: one whisper-cli run of the requested model with DTW timing (also used when the
 *   requested model is the small timing model itself).
 *
 * Both paths decode the media once into a 16 kHz WAV while measuring 10 ms levels, which
 * refine word boundaries acoustically and filter hallucinations in silence.
 */
import os from 'node:os'
import path from 'node:path'
import type { Word } from '@reelforge/core'
import type { JobContext, JobDefinition } from '../../contracts.ts'
import { cacheOnAsset, resolveAsset, streamPcm, withTempDir } from '../media.ts'
import { parsePayload, TranscribePayloadSchema, type TranscribeOptions } from '../payloads.ts'
import { LevelMeter } from '../silence.ts'
import { alignToTimedWords } from './align.ts'
import {
  alignmentModel,
  hasWhisperFilter,
  listModels,
  physicalCores,
  resolveModel,
  runFfmpegWhisper,
  runWhisperCli,
  whisperCliPath,
  type ModelInfo,
} from './engines.ts'
import { refineWithLevels } from './refine.ts'
import type { RawWord } from './whisper-json.ts'
import { markEmphasis, markFillers, sanitizeTimings } from './words.ts'

const SAMPLE_RATE = 16_000
/** Share of the progress bar spent decoding audio. */
const DECODE_SHARE = 0.08
/** Conservative GPU realtime factor used to animate progress while FFmpeg reports none. */
const FILTER_RTF_ESTIMATE = 0.3

export interface TranscribeResult {
  language: string
  backend: 'hybrid' | 'cli'
  model: string
  /** Model that timed the words (differs from `model` in hybrid mode). */
  timingModel: string
  words: Word[]
  /** Recognition wall time / audio duration (lower is faster). */
  realtimeFactor: number
}

interface Plan {
  backend: 'hybrid' | 'cli'
  main: ModelInfo
  timing: ModelInfo
  cli: string
}

const plan = async (ctx: JobContext, opts: TranscribeOptions): Promise<Plan> => {
  const models = await listModels(ctx.paths.models)
  const main = resolveModel(models, opts.model)
  const cli = whisperCliPath(ctx.tools.whisper, ctx.paths.bin)
  if (!cli) throw new Error('whisper.cpp is not installed — run `pnpm bootstrap`')
  const timing = alignmentModel(models)
  const want = opts.backend ?? 'auto'
  const hybridOk =
    timing !== undefined && timing.id !== main.id && (await hasWhisperFilter(ctx.tools.ffmpeg))
  if (want === 'hybrid' && !hybridOk) {
    throw new Error(
      'hybrid transcription needs FFmpeg with the whisper filter and a small timing model (base/tiny) different from the main model',
    )
  }
  if (hybridOk && want !== 'cli' && timing) return { backend: 'hybrid', main, timing, cli }
  return { backend: 'cli', main, timing: main, cli }
}

const toWord = (w: RawWord): Word => ({
  text: w.text,
  start: w.start,
  end: w.end,
  confidence: Math.round(Math.min(1, Math.max(0, w.confidence)) * 1000) / 1000,
  filler: false,
  emphasis: false,
})

export const transcribeJob: JobDefinition = {
  kind: 'transcribe',
  resource: 'ai',
  defaultPriority: 40,
  handler: async (ctx): Promise<TranscribeResult> => {
    const opts = parsePayload(TranscribePayloadSchema, ctx.payload)
    const { asset, file } = resolveAsset(ctx, opts.assetId)
    if (asset.kind === 'image') throw new Error('images have no audio to transcribe')
    const p = await plan(ctx, opts)
    const language = opts.language ?? 'auto'
    const total = asset.duration ?? 0

    return withTempDir(ctx.paths, 'transcribe', async (dir) => {
      // 1. One decode → 16 kHz s16 WAV for whisper + float levels for boundary refinement.
      const wav = path.join(dir, 'audio.wav')
      const meter = new LevelMeter(SAMPLE_RATE)
      ctx.progress(0, 'Extracting audio')
      const samples = await streamPcm({
        ffmpeg: ctx.tools.ffmpeg,
        file,
        sampleRate: SAMPLE_RATE,
        signal: ctx.signal,
        extraOutputs: [
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          String(SAMPLE_RATE),
          '-c:a',
          'pcm_s16le',
          wav,
        ],
        onSamples: (s) => meter.push(s),
        onTime: (t) => {
          if (total > 0)
            ctx.progress((DECODE_SHARE * Math.min(t, total)) / total, 'Extracting audio')
        },
      })
      const durationUs = Math.round((samples * 1_000_000) / SAMPLE_RATE)
      if (durationUs === 0) throw new Error('the audio track is empty')
      const levels = meter.finish()

      // 2. Recognition.
      const threads = physicalCores(ctx.tools.cpuThreads || os.availableParallelism())
      const started = performance.now()
      const label =
        p.backend === 'hybrid' ? `Transcribing (${p.main.id}, GPU)` : `Transcribing (${p.main.id})`
      let cliP = 0
      const report = (): void => {
        const est =
          p.backend === 'hybrid'
            ? Math.min(
                0.95,
                (performance.now() - started) / ((durationUs / 1000) * FILTER_RTF_ESTIMATE),
              )
            : cliP
        const f = p.backend === 'hybrid' ? 0.5 * est + 0.5 * cliP : cliP
        ctx.progress(DECODE_SHARE + (0.97 - DECODE_SHARE) * f, label)
      }
      const ticker = p.backend === 'hybrid' ? setInterval(report, 500) : undefined
      // If one engine fails, stop the other one instead of letting it run to completion.
      const inner = new AbortController()
      const onOuterAbort = (): void => inner.abort()
      ctx.signal.addEventListener('abort', onOuterAbort, { once: true })
      let raw: RawWord[]
      let detected: string | undefined
      try {
        const timed = runWhisperCli({
          exe: p.cli,
          model: p.timing,
          wav,
          outBase: path.join(dir, 'timing'),
          language,
          threads,
          dtw: true,
          greedy: p.backend === 'hybrid',
          signal: inner.signal,
          onProgress: (f) => {
            cliP = f
            if (p.backend === 'cli') report()
          },
        })
        if (p.backend === 'hybrid') {
          const text = runFfmpegWhisper({
            ffmpeg: ctx.tools.ffmpeg,
            model: p.main,
            wav,
            dir,
            language,
            durationUs,
            signal: inner.signal,
          })
          const [t, segments] = await Promise.all([timed, text]).catch((err: unknown) => {
            inner.abort()
            throw err
          })
          detected = t.language
          raw = alignToTimedWords(segments, t.words)
        } else {
          const t = await timed
          detected = t.language
          raw = t.words
        }
      } finally {
        if (ticker) clearInterval(ticker)
        ctx.signal.removeEventListener('abort', onOuterAbort)
      }
      const elapsed = performance.now() - started

      // 3. Post-processing.
      const refined = refineWithLevels(
        raw.filter((w) => w.start < durationUs),
        levels,
      )
      const words = sanitizeTimings(refined.map(toWord), durationUs)
      const lang = language !== 'auto' ? language : (detected ?? 'auto')
      markFillers(words, { language: lang, ...(opts.fillers ? { extra: opts.fillers } : {}) })
      markEmphasis(words)

      cacheOnAsset(ctx, asset.id, { transcript: words })
      ctx.progress(1, `${words.length} words · ${lang}`)
      ctx.log.info(
        {
          assetId: asset.id,
          backend: p.backend,
          model: p.main.id,
          rtf: elapsed / (durationUs / 1000),
        },
        'transcribed',
      )
      return {
        language: lang,
        backend: p.backend,
        model: p.main.id,
        timingModel: p.timing.id,
        words,
        realtimeFactor: Math.round((elapsed / (durationUs / 1000)) * 1000) / 1000,
      }
    })
  },
}
