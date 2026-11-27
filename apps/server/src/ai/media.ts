/**
 * Media plumbing for the AI jobs: asset lookup + cache writes, temp dirs, streaming PCM
 * decode through FFmpeg and FFmpeg progress parsing.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Asset } from '@reelforge/core'
import type { DataPaths, JobContext } from '../contracts.ts'
import { assetFile } from '../paths.ts'
import { run, ToolError } from './proc.ts'

export interface ResolvedAsset {
  asset: Asset
  /** Absolute path of the original upload. */
  file: string
}

/** Look up an asset and its original file, with errors a user can act on. */
export const resolveAsset = (ctx: JobContext, assetId: string | undefined): ResolvedAsset => {
  if (!assetId) throw new Error('payload.assetId is required')
  const asset = ctx.store.getAsset(assetId)
  if (!asset) throw new Error(`asset ${assetId} not found`)
  const file = assetFile(ctx.paths, asset, 'original')
  if (!existsSync(file)) throw new Error(`original file for asset ${assetId} is missing`)
  return { asset, file }
}

/** Persist analysis results on the asset and broadcast the change to every client. */
export const cacheOnAsset = (ctx: JobContext, assetId: string, patch: Partial<Asset>): Asset => {
  const asset = ctx.store.patchAsset(assetId, patch)
  ctx.emit({ type: 'asset', asset })
  return asset
}

/** Create a private temp dir under the data dir, run `fn`, always clean up. */
export const withTempDir = async <T>(
  paths: DataPaths,
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
  await mkdir(paths.tmp, { recursive: true })
  const dir = await mkdtemp(path.join(paths.tmp, `${prefix}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

/** FFmpeg `-progress` key/value line → processed media time in us (or undefined). */
export const parseProgressLine = (line: string): number | undefined => {
  // out_time_us is the precise key; "N/A" appears before the first frame.
  if (!line.startsWith('out_time_us=')) return undefined
  const v = Number(line.slice(12))
  return Number.isFinite(v) && v >= 0 ? v : undefined
}

/** Common leading FFmpeg arguments: quiet logs, machine-readable progress on stderr. */
export const FF_BASE = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error'] as const
export const FF_PROGRESS = ['-progress', 'pipe:2', '-stats_period', '0.25'] as const

/**
 * Hardware decode for analysis passes. On Windows D3D11VA is requested explicitly: measured
 * on a 30 s 4K HEVC clip (Radeon 780M) it decodes+samples in 6.4 s vs 8.1 s with `auto` and
 * 17.9 s in software. FFmpeg falls back to software decoding for unsupported codecs.
 */
export const FF_HWACCEL = ['-hwaccel', process.platform === 'win32' ? 'd3d11va' : 'auto'] as const

export interface PcmStreamOptions {
  ffmpeg: string
  file: string
  sampleRate: number
  signal?: AbortSignal
  /** Receives mono float32 samples; the array may be transferred/retained by the consumer. */
  onSamples: (samples: Float32Array<ArrayBuffer>) => void | Promise<void>
  /** Decoded media time in us. */
  onTime?: (us: number) => void
  /**
   * Additional FFmpeg outputs written from the same decode (e.g. a WAV for whisper), given as
   * output options + target, inserted before the PCM pipe output.
   */
  extraOutputs?: readonly string[]
  /**
   * Source channel count. When known and > 1, channels are averaged (`pan`) instead of
   * FFmpeg's `-ac 1` downmix, which preserves energy and comes out √2 louder for stereo.
   */
  channels?: number
}

/** `pan` filter that averages `n` channels into one (the arithmetic-mean downmix). */
export const meanDownmix = (n: number): string =>
  `pan=mono|c0=${Array.from({ length: n }, (_, i) => `${1 / n}*c${i}`).join('+')}`

/**
 * Decode the first audio stream to mono float32 PCM at `sampleRate`, streamed through a
 * pipe in chunks (never buffers the whole file). Resolves with the number of samples.
 */
export const streamPcm = async (opts: PcmStreamOptions): Promise<number> => {
  let carry: Uint8Array = new Uint8Array(0)
  let total = 0
  const args = [
    ...FF_BASE,
    ...FF_PROGRESS,
    '-i',
    opts.file,
    ...(opts.extraOutputs ?? []),
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    ...(opts.channels && opts.channels > 1 ? ['-af', meanDownmix(opts.channels)] : []),
    '-ac',
    '1',
    '-ar',
    String(opts.sampleRate),
    '-f',
    'f32le',
    'pipe:1',
  ]
  const r = await run(opts.ffmpeg, args, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    onStderrLine: (line) => {
      const t = parseProgressLine(line)
      if (t !== undefined) opts.onTime?.(t)
    },
    onStdoutData: (chunk) => {
      // Float32Array views need 4-byte alignment and whole samples: copy once into a fresh,
      // aligned buffer that the consumer may keep or transfer to a worker.
      const bytes = carry.length + chunk.length
      const usable = bytes - (bytes % 4)
      if (usable === 0) {
        carry = Buffer.concat([carry, chunk])
        return undefined
      }
      const samples = new Float32Array(usable / 4)
      const view = new Uint8Array(samples.buffer)
      view.set(carry.subarray(0, Math.min(carry.length, usable)), 0)
      const fromChunk = usable - carry.length
      view.set(chunk.subarray(0, fromChunk), carry.length)
      carry = chunk.subarray(fromChunk)
      total += samples.length
      return opts.onSamples(samples)
    },
  })
  if (r.code !== 0) {
    const noAudio = r.stderrTail.some((l) =>
      /matches no streams|does not contain any stream/i.test(l),
    )
    if (noAudio) throw new Error('this media has no audio track')
    throw new ToolError('ffmpeg', r.code, r.stderrTail)
  }
  return total
}
