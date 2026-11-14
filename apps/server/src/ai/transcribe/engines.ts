/**
 * Speech-recognition engines:
 * - `whisper-cli` (whisper.cpp, CPU build on Windows): full JSON with token probabilities and
 *   DTW word timing.
 * - FFmpeg's `whisper` filter (statically linked whisper.cpp with GPU offload — Vulkan on the
 *   Gyan Windows builds): ~5× faster for large models on an iGPU, but segment text only.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { FF_BASE } from '../media.ts'
import { run, runChecked } from '../proc.ts'
import {
  parseFfmpegSegments,
  parseWhisperFullJson,
  type ParsedTranscript,
  type TextSegment,
  type WhisperFullJson,
} from './whisper-json.ts'

export const WHISPER_EXE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

/** Preference order for the default model: accuracy first, then whatever is installed. */
const DEFAULT_ORDER = [
  /^large-v3-turbo-q5_0$/,
  /^large-v3-turbo/,
  /^large-v3/,
  /^medium/,
  /^small/,
  /^base/,
  /^tiny/,
]
/** Preference order for the fast DTW timing model used by the hybrid backend. */
const ALIGN_ORDER = [/^base(-q\d_\d)?$/, /^base\.en/, /^tiny(-q\d_\d)?$/, /^small(-q\d_\d)?$/]

export interface ModelInfo {
  /** e.g. `large-v3-turbo-q5_0` */
  id: string
  file: string
}

/** Installed whisper ggml models in `<models>/whisper` (VAD models excluded). */
export const listModels = async (modelsDir: string): Promise<ModelInfo[]> => {
  const dir = path.join(modelsDir, 'whisper')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => /^ggml-.+\.bin$/.test(n) && !n.includes('silero') && !n.includes('vad'))
    .map((n) => ({ id: n.slice(5, -4), file: path.join(dir, n) }))
}

const pick = (models: readonly ModelInfo[], order: readonly RegExp[]): ModelInfo | undefined => {
  for (const re of order) {
    const m = models.find((x) => re.test(x.id))
    if (m) return m
  }
  return undefined
}

/** Resolve a requested model id/file name (or the best default) to an installed model. */
export const resolveModel = (models: readonly ModelInfo[], requested?: string): ModelInfo => {
  if (requested) {
    const id = requested.replace(/^ggml-/, '').replace(/\.bin$/, '')
    const m = models.find((x) => x.id === id)
    if (!m) {
      throw new Error(
        `whisper model "${id}" is not installed (have: ${models.map((x) => x.id).join(', ') || 'none'}) — run \`pnpm bootstrap -- --models ${id}\``,
      )
    }
    return m
  }
  const m = pick(models, DEFAULT_ORDER) ?? models[0]
  if (!m) throw new Error('no whisper model installed — run `pnpm bootstrap`')
  return m
}

/** Small model used to time words in hybrid mode (undefined if none is installed). */
export const alignmentModel = (models: readonly ModelInfo[]): ModelInfo | undefined =>
  pick(models, ALIGN_ORDER)

/** whisper.cpp `--dtw` alignment-heads preset for a model id (undefined: no preset). */
export const dtwPreset = (modelId: string): string | undefined => {
  const m =
    /^(tiny|base|small|medium|large-v1|large-v2|large-v3-turbo|large-v3)(\.en)?(?:-q\d_\d)?$/.exec(
      modelId,
    )
  if (!m) return undefined
  return `${(m[1] ?? '').replace(/-/g, '.')}${m[2] ?? ''}`
}

/** Locate whisper-cli: the toolchain's detection, else the bootstrap location. */
export const whisperCliPath = (
  toolPath: string | undefined,
  binDir: string,
): string | undefined => {
  if (toolPath && existsSync(toolPath)) return toolPath
  const p = path.join(binDir, 'whisper', WHISPER_EXE)
  return existsSync(p) ? p : undefined
}

const filterSupport = new Map<string, Promise<boolean>>()

/** Whether this FFmpeg build has the `whisper` audio filter (checked once per binary). */
export const hasWhisperFilter = (ffmpeg: string): Promise<boolean> => {
  let p = filterSupport.get(ffmpeg)
  if (!p) {
    p = (async () => {
      let found = false
      try {
        await run(ffmpeg, ['-hide_banner', '-filters'], {
          onStdoutLine: (line) => {
            if (/^\s*\S+\s+whisper\s+A->A\b/.test(line)) found = true
          },
        })
      } catch {
        return false
      }
      return found
    })()
    filterSupport.set(ffmpeg, p)
  }
  return p
}

/**
 * Escape a value for use inside an FFmpeg filtergraph option (two levels: the option parser,
 * then the graph parser). Paths are normalised to forward slashes first.
 */
export const escapeFilterValue = (value: string): string =>
  value
    .replace(/\\/g, '/')
    .replace(/[\\':]/g, '\\$&')
    .replace(/[\\'[\],;]/g, '\\$&')

/** Physical cores (whisper.cpp scales with cores; SMT siblings only add contention). */
export const physicalCores = (logical: number): number => Math.max(1, Math.floor(logical / 2))

export interface CliRunOptions {
  exe: string
  model: ModelInfo
  wav: string
  outBase: string
  language: string
  threads: number
  /** Use DTW alignment heads for the model (requires flash attention off). */
  dtw: boolean
  /** Greedy decoding (fast timing pass) instead of beam search. */
  greedy?: boolean
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/** Build the whisper-cli argv (exported for tests). */
export const buildCliArgs = (o: Omit<CliRunOptions, 'exe' | 'signal' | 'onProgress'>): string[] => {
  const preset = o.dtw ? dtwPreset(o.model.id) : undefined
  return [
    '-m',
    o.model.file,
    '-f',
    o.wav,
    '-l',
    o.language,
    '-t',
    String(o.threads),
    '-ojf',
    '-of',
    o.outBase,
    '-pp',
    '-np',
    // Non-speech tokens ("(music)", "*sigh*") are useless as captions.
    '-sns',
    ...(o.greedy ? ['-bs', '1', '-bo', '1'] : []),
    // whisper.cpp computes DTW timestamps only with flash attention disabled.
    ...(preset ? ['-dtw', preset, '-nfa'] : []),
  ]
}

/** `whisper_print_progress_callback: progress =  45%` → 0.45 */
export const parseCliProgress = (line: string): number | undefined => {
  const m = /progress\s*=\s*(\d+)%/.exec(line)
  return m ? Number(m[1]) / 100 : undefined
}

/** Run whisper-cli and parse its full JSON output. */
export const runWhisperCli = async (o: CliRunOptions): Promise<ParsedTranscript> => {
  await runChecked('whisper-cli', o.exe, buildCliArgs(o), {
    // DLLs live next to the executable.
    cwd: path.dirname(o.exe),
    ...(o.signal ? { signal: o.signal } : {}),
    onStderrLine: (line) => {
      const p = parseCliProgress(line)
      if (p !== undefined) o.onProgress?.(p)
    },
    onStdoutLine: (line) => {
      const p = parseCliProgress(line)
      if (p !== undefined) o.onProgress?.(p)
    },
  })
  const json = JSON.parse(await readFile(`${o.outBase}.json`, 'utf8')) as WhisperFullJson
  return parseWhisperFullJson(json)
}

export interface FilterRunOptions {
  ffmpeg: string
  model: ModelInfo
  wav: string
  /** Directory for the segment file (also the process cwd). */
  dir: string
  language: string
  durationUs: number
  signal?: AbortSignal
}

/**
 * Transcribe with FFmpeg's whisper filter. The queue is set longer than the audio so
 * whisper.cpp sees the whole file in one `whisper_full` call (its own 30 s windows with
 * context carry-over) — short queues cut words at chunk borders and repeat them.
 */
export const runFfmpegWhisper = async (o: FilterRunOptions): Promise<TextSegment[]> => {
  const out = 'segments.jsonl'
  const queueSec = Math.ceil(o.durationUs / 1_000_000) + 5
  const filter =
    `whisper=model=${escapeFilterValue(o.model.file)}` +
    `:language=${o.language}:queue=${queueSec}:format=json:destination=${out}`
  await runChecked(
    'ffmpeg whisper',
    o.ffmpeg,
    [...FF_BASE, '-i', o.wav, '-af', filter, '-f', 'null', '-'],
    {
      cwd: o.dir,
      ...(o.signal ? { signal: o.signal } : {}),
    },
  )
  return parseFfmpegSegments(await readFile(path.join(o.dir, out), 'utf8'))
}
