/**
 * The render pipeline shared by exports and previews:
 *
 *   project → assets (+ colour info) → pack lookups → baked LUT mixes → ASS (text/captions)
 *   → [loudness analysis pass] → compileRender → ffmpeg (GPU encoder, CPU fallback)
 *   → atomic rename → poster
 *
 * All intermediate files live in a per-job work directory under `paths.tmp` that is removed
 * when the job ends, whatever the outcome.
 */
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildAss,
  compileLoudnessAnalysis,
  compileRender,
  exportSize,
  type AssContext,
  type CompileContext,
  type ExportSettings,
  type LoudnessMeasurement,
  type Project,
} from '@reelforge/core'
import type { JobContext } from '../contracts.ts'
import { flatFontsDir } from '../packs/fonts.ts'
import { collectAssets } from './assets.ts'
import { cpuEncoder, pickEncoder, type EncoderPick } from './encoders.ts'
import {
  FfmpegAbortError,
  FfmpegError,
  parseLoudnorm,
  runFfmpeg,
  type FfmpegProgress,
} from './ffmpeg.ts'
import { bakeLutMix, quantizeIntensity } from './lut.ts'
import { loadPackResolvers, projectRefs, type PackResolvers } from './packs.ts'

/** Pluggable collaborators (tests substitute a handwritten ASS until core's builder lands). */
export interface RenderDeps {
  buildAss: (project: Project, ctx: AssContext) => string
}

export const defaultDeps: RenderDeps = { buildAss }

export interface RenderRequest {
  project: Project
  settings: ExportSettings
  /** Final output file (written atomically). */
  output: string
  /** Override the output size (previews). */
  size?: { width: number; height: number }
  /** Interactive preview: fastest encoder presets, no loudness analysis pass, no poster. */
  preview?: boolean
}

export interface RenderOutcome {
  file: string
  size: number
  /** Output duration (us). */
  duration: number
  width: number
  height: number
  encoder: string
  fallbackUsed: boolean
  /** Why the hardware encoder was abandoned (when `fallbackUsed`). */
  fallbackReason?: string
  /** Media seconds produced per wall-clock second for the whole job. */
  realtimeFactor: number
  /** Poster frame (JPEG next to the output), when written. */
  poster?: string
}

/** True when the project has anything for the ASS builder to draw. */
export function hasText(p: Project): boolean {
  if (p.captions?.enabled && p.captions.words.length > 0) return true
  return p.tracks.some(
    (t) =>
      t.kind === 'text' && !t.hidden && t.clips.some((c) => c.type === 'text' && c.text.trim()),
  )
}

/** Bake partial-intensity LUTs up front so the compiler's resolver is synchronous. */
async function bakeLuts(
  p: Project,
  packs: PackResolvers,
  cacheDir: string,
): Promise<Map<string, string>> {
  const jobs = new Map<string, Promise<string | undefined>>()
  for (const track of p.tracks) {
    for (const c of track.clips) {
      if ((c.type !== 'video' && c.type !== 'image') || !c.filter) continue
      const k = quantizeIntensity(c.filter.intensity)
      if (k <= 0 || k >= 1) continue
      const key = `${c.filter.ref}@${k}`
      const src = packs.resolveLut(c.filter.ref)
      if (!src || jobs.has(key)) continue
      jobs.set(
        key,
        bakeLutMix(src, k, cacheDir).catch(() => undefined),
      )
    }
  }
  const baked = await Promise.all([...jobs].map(async ([key, job]) => [key, await job] as const))
  const out = new Map<string, string>()
  for (const [key, file] of baked) if (file) out.set(key, file)
  return out
}

/** Progress reporting for one ffmpeg pass mapped into [from, to] of the job. */
function passProgress(
  ctx: JobContext,
  durationUs: number,
  from: number,
  to: number,
  label: string,
): (p: FfmpegProgress) => void {
  return (p) => {
    if (p.outTimeUs === undefined) return
    const f = Math.min(1, p.outTimeUs / Math.max(1, durationUs))
    const parts = [label]
    if (p.speed !== undefined && p.speed > 0) parts.push(`${p.speed.toFixed(1)}x`)
    if (p.fps !== undefined && p.fps > 0) parts.push(`${Math.round(p.fps)} fps`)
    const eta =
      p.speed !== undefined && p.speed > 0
        ? Math.round((durationUs - Math.min(durationUs, p.outTimeUs)) / p.speed)
        : undefined
    ctx.progress(from + (to - from) * f, parts.join(' · '), eta)
  }
}

/** Source codecs decoded on the GPU when the toolchain offers a hardware decoder. */
const HW_DECODE_CODECS: readonly string[] = ['hevc']

async function removeQuietly(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined)
}

/** Render a project to `req.output`. Honours `ctx.signal`; never leaves a partial output. */
export async function renderProject(
  ctx: JobContext,
  req: RenderRequest,
  deps: RenderDeps = defaultDeps,
): Promise<RenderOutcome> {
  const started = performance.now()
  const { project, settings } = req
  const work = path.join(ctx.paths.tmp, `render-${ctx.job.id}`)
  const partial = `${req.output}.part`
  await mkdir(work, { recursive: true })
  await mkdir(path.dirname(req.output), { recursive: true })
  try {
    ctx.progress(0, 'Preparing')
    const [assets, packs] = await Promise.all([
      collectAssets(project, {
        store: ctx.store,
        paths: ctx.paths,
        ffprobe: ctx.tools.ffprobe,
        signal: ctx.signal,
      }),
      loadPackResolvers(ctx.paths.packs, projectRefs(project), ctx.log),
    ])
    const baked = await bakeLuts(project, packs, path.join(ctx.paths.tmp, 'luts'))
    ctx.signal.throwIfAborted()

    let assPath: string | undefined
    // libass scans only one flat directory; pack fonts live in per-family folders.
    let fontsDir = ''
    if (hasText(project)) {
      assPath = path.join(work, 'text.ass')
      ;[fontsDir] = await Promise.all([
        flatFontsDir({ root: ctx.paths.root, packs: packs.root }),
        writeFile(
          assPath,
          deps.buildAss(project, { resolveAnimation: (r) => packs.resolveAnimation(r) }),
        ),
      ])
    }

    const size = req.size ?? exportSize(settings.resolution)
    const fps = settings.fps ?? project.settings.fps
    const target = {
      width: size.width,
      height: size.height,
      fps,
      quality: settings.quality,
      codec: settings.codec,
      preview: req.preview,
    }
    const base: Omit<CompileContext, 'encoder' | 'filterGraphPath' | 'output'> = {
      assets,
      settings,
      assPath,
      fontsDir,
      resolveLut: (r) => packs.resolveLut(r),
      resolveLutMix: (r, k) => baked.get(`${r}@${quantizeIntensity(k)}`),
      resolveSticker: (r) => packs.resolveSticker(r),
      resolveEffect: (r) => packs.resolveEffect(r),
      resolveAnimation: (r) => packs.resolveAnimation(r),
      rnnoiseModel: await findRnnoiseModel(ctx.paths.models),
      size,
      // Measured on the Ryzen 7 8840U / 780M (10 s 2160×3840 → 1080×1920, AMF encode):
      // d3d11va decode is ~19 % faster for HEVC but ~20 % slower for H.264, whose software
      // decoder outruns the GPU→RAM frame copy. So only HEVC (most phone footage) uses it.
      ...(ctx.tools.hwDecode
        ? { hwaccel: ctx.tools.hwDecode, hwaccelCodecs: HW_DECODE_CODECS }
        : {}),
    }

    let encodeFrom = 0
    let loudness: LoudnessMeasurement | undefined
    let effective = settings
    if (settings.normalizeLoudness && !req.preview) {
      const analysis = compileLoudnessAnalysis(project, {
        ...base,
        encoder: { video: 'none', args: [] },
        filterGraphPath: path.join(work, 'loudness.txt'),
        output: '-',
      })
      if (analysis) {
        encodeFrom = 0.1
        await writeFile(analysis.filterGraphPath, analysis.filterGraph)
        const { stderr } = await runFfmpeg({
          bin: ctx.tools.ffmpeg,
          args: ['-progress', 'pipe:1', '-nostats', ...analysis.args],
          signal: ctx.signal,
          onProgress: passProgress(ctx, analysis.duration, 0, encodeFrom, 'Analysing audio'),
        })
        loudness = parseLoudnorm(stderr)
        // Unmeasurable (digital silence): normalising would only amplify noise.
        if (!loudness) effective = { ...settings, normalizeLoudness: false }
      }
    }

    const encode = async (encoder: EncoderPick): Promise<number> => {
      const plan = compileRender(project, {
        ...base,
        settings: effective,
        loudness,
        encoder,
        filterGraphPath: path.join(work, 'graph.txt'),
        output: partial,
      })
      await writeFile(plan.filterGraphPath, plan.filterGraph)
      await runFfmpeg({
        bin: ctx.tools.ffmpeg,
        args: ['-progress', 'pipe:1', '-nostats', ...plan.args],
        signal: ctx.signal,
        onProgress: passProgress(ctx, plan.duration, encodeFrom, 0.98, 'Encoding'),
      })
      return plan.duration
    }

    let encoder = pickEncoder(settings.encoder, ctx.tools.hwEncoders, target)
    let fallbackReason: string | undefined
    let duration: number
    try {
      duration = await encode(encoder)
    } catch (err) {
      if (!encoder.hardware || !(err instanceof FfmpegError)) throw err
      // The GPU encoder failed (driver hiccup, session limit, unsupported size…): redo the
      // whole render on the CPU rather than fail the export.
      fallbackReason = err.message
      ctx.log.warn({ encoder: encoder.video, err: err.message }, 'GPU encode failed; using CPU')
      await removeQuietly(partial)
      encoder = cpuEncoder(target)
      duration = await encode(encoder)
    }

    await rename(partial, req.output)
    let poster: string | undefined
    if (!req.preview) {
      poster = await writePoster(ctx, req.output, duration).catch(() => undefined)
    }
    const { size: bytes } = await stat(req.output)
    const wall = (performance.now() - started) / 1000
    ctx.progress(1, 'Done')
    return {
      file: req.output,
      size: bytes,
      duration,
      width: size.width,
      height: size.height,
      encoder: encoder.video,
      fallbackUsed: fallbackReason !== undefined,
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
      realtimeFactor: Math.round((duration / 1e6 / Math.max(1e-3, wall)) * 100) / 100,
      ...(poster ? { poster } : {}),
    }
  } catch (err) {
    await removeQuietly(partial)
    if (err instanceof FfmpegAbortError || ctx.signal.aborted) {
      throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new FfmpegAbortError()
    }
    throw err
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** First RNNoise model (`<models>/rnnoise/*.rnnn`), if installed. */
async function findRnnoiseModel(models: string): Promise<string | undefined> {
  try {
    const dir = path.join(models, 'rnnoise')
    const file = (await readdir(dir)).toSorted().find((f) => f.endsWith('.rnnn'))
    return file ? path.join(dir, file) : undefined
  } catch {
    return undefined
  }
}

/** A 540-px-wide JPEG poster next to the output (`<name>.jpg`). */
async function writePoster(ctx: JobContext, video: string, durationUs: number): Promise<string> {
  const poster = video.replace(/\.mp4$/i, '') + '.jpg'
  const at = Math.min(durationUs / 3, 3_000_000) / 1e6
  await runFfmpeg({
    bin: ctx.tools.ffmpeg,
    args: [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-ss',
      at.toFixed(3),
      '-i',
      video,
      '-frames:v',
      '1',
      '-vf',
      'scale=540:-2:flags=bicubic',
      '-q:v',
      '3',
      poster,
    ],
    signal: ctx.signal,
  })
  return poster
}
