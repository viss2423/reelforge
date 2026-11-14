/**
 * `scenes` job: shot-cut detection with FFmpeg `scdet` on a 320 px downscale (hardware
 * decode when available). Cut times are the first frame of each new shot, in source us.
 */
import type { JobDefinition } from '../contracts.ts'
import { cacheOnAsset, FF_HWACCEL, FF_PROGRESS, parseProgressLine, resolveAsset } from './media.ts'
import { parsePayload, ScenesPayloadSchema } from './payloads.ts'
import { runChecked } from './proc.ts'

/** Cuts closer than this to the previous one are flashes/strobes, not new shots. */
export const MIN_SHOT_US = 250_000

/** `[Parsed_scdet_1 @ …] lavfi.scd.score: 22.564, lavfi.scd.time: 2.002` → us */
export const parseScdetLine = (line: string): number | undefined => {
  const m = /lavfi\.scd\.time:\s*(-?[\d.]+)/.exec(line)
  if (!m) return undefined
  const t = Number(m[1])
  return Number.isFinite(t) && t > 0 ? Math.round(t * 1_000_000) : undefined
}

/** Sort, de-duplicate and drop cuts within `minShot` of the previous kept cut. */
export const cleanCuts = (cuts: readonly number[], minShot = MIN_SHOT_US): number[] => {
  const out: number[] = []
  for (const t of cuts.toSorted((a, b) => a - b)) {
    const last = out.at(-1)
    if (t >= minShot && (last === undefined || t - last >= minShot)) out.push(t)
  }
  return out
}

export interface SceneOptions {
  ffmpeg: string
  file: string
  /** scdet threshold in percent (default 10). */
  threshold?: number
  signal?: AbortSignal
  onTime?: (us: number) => void
}

/** Detect shot cuts in a video file. */
export const detectScenes = async (o: SceneOptions): Promise<number[]> => {
  const cuts: number[] = []
  await runChecked(
    'ffmpeg scdet',
    o.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      // scdet reports through the log at info level; everything else stays quiet enough.
      '-loglevel',
      'info',
      ...FF_PROGRESS,
      ...FF_HWACCEL,
      '-i',
      o.file,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `scale=320:-2:flags=fast_bilinear,scdet=threshold=${o.threshold ?? 10}`,
      '-f',
      'null',
      '-',
    ],
    {
      ...(o.signal ? { signal: o.signal } : {}),
      onStderrLine: (line) => {
        const cut = parseScdetLine(line)
        if (cut !== undefined) {
          cuts.push(cut)
          return
        }
        const t = parseProgressLine(line)
        if (t !== undefined) o.onTime?.(t)
      },
    },
  )
  return cleanCuts(cuts)
}

export const scenesJob: JobDefinition = {
  kind: 'scenes',
  resource: 'cpu',
  defaultPriority: 30,
  handler: async (ctx) => {
    const opts = parsePayload(ScenesPayloadSchema, ctx.payload)
    const { asset, file } = resolveAsset(ctx, opts.assetId)
    if (asset.kind !== 'video') throw new Error('scene detection needs a video asset')
    const total = asset.duration ?? 0
    ctx.progress(0, 'Detecting scenes')
    const scenes = await detectScenes({
      ffmpeg: ctx.tools.ffmpeg,
      file,
      signal: ctx.signal,
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      onTime: (t) => {
        if (total > 0) ctx.progress(Math.min(0.99, t / total), 'Detecting scenes')
      },
    })
    cacheOnAsset(ctx, asset.id, { scenes })
    ctx.progress(1, `${scenes.length} cuts`)
    return { scenes }
  },
}
