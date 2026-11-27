/**
 * Project → FFmpeg render plan. Pure: no I/O. The server writes `filterGraph` to
 * `filterGraphPath` and runs `ffmpeg ...args`.
 *
 * Graph shape (see ARCHITECTURE.md "Render compiler"): per main-track clip
 * decode/trim/speed → one scale to its export-resolution size → look → geometry → effects,
 * joined by concat / xfade transitions → overlay-track sprites → `ass` (text + captions) →
 * output format + BT.709 tags. Audio: per-clip chains → buses (ducking) → amix → loudnorm.
 *
 * Everything is composited directly at the export resolution (each source is resampled once,
 * with lanczos at high/max quality), so there is no separate output scaling pass.
 *
 * Only the public surface lives here because `@reelforge/core` re-exports this module.
 */
import type { ExportSettings, Project } from '../schema.ts'
import { buildAudio } from './audio.ts'
import { CompileError } from './errors.ts'
import { secs } from './expr.ts'
import { Graph } from './graph.ts'
import { renderLayout, renderDuration, renderWindow, type FrameSpan } from './layout.ts'
import type { CompileContext, RenderPlan } from './types.ts'
import {
  applyBehindText,
  applyText,
  buildMainTrack,
  buildOverlays,
  finishVideo,
  hasSubject,
} from './video.ts'
import { CANVAS_W, type VideoEnv } from './visual.ts'

export type {
  CompileAsset,
  CompileContext,
  EncoderChoice,
  LoudnessMeasurement,
  RenderPlan,
} from './types.ts'
export { CompileError } from './errors.ts'
export { ADJUSTMENT_MAPPING, chromaCurve, lumaCurve, lutyuvFilter } from './adjustments.ts'
export { AUTO_MOTION, BACKGROUND_BLUR_SIGMA, MATTE_FEATHER_SIGMA, STICKER_BOX } from './visual.ts'
export { LOUDNESS } from './audio.ts'

/** Output size for an export resolution preset (always 9:16, even dimensions). */
export function exportSize(resolution: ExportSettings['resolution']): {
  width: number
  height: number
} {
  switch (resolution) {
    case '720p':
      return { width: 720, height: 1280 }
    case '1080p':
      return { width: 1080, height: 1920 }
    case '1440p':
      return { width: 1440, height: 2560 }
    case '2160p':
      return { width: 2160, height: 3840 }
  }
}

/** swscale flags per export quality (the one resampling every source goes through). */
const SCALERS: Readonly<Record<ExportSettings['quality'], string>> = {
  draft: 'bilinear',
  standard: 'bicubic',
  high: 'lanczos',
  max: 'lanczos+accurate_rnd+full_chroma_int',
}

interface Prepared {
  fps: number
  window: FrameSpan
  frames: number
  layout: ReturnType<typeof renderLayout>
}

function prepare(project: Project, ctx: CompileContext): Prepared {
  const fps = ctx.settings.fps ?? project.settings.fps
  const layout = renderLayout(project)
  const total = renderDuration(project, layout)
  if (total <= 0) throw new CompileError('empty_project', `project ${project.id} has no clips`)
  const window = renderWindow(total, ctx.settings.range, fps)
  const frames = window.end - window.start
  if (frames <= 0) throw new CompileError('empty_range', 'export range contains no frames')
  return { fps, window, frames, layout }
}

const durationUs = (frames: number, fps: number): number => Math.round((frames * 1e6) / fps)

/** Compile a project into the full export command. */
export function compileRender(project: Project, ctx: CompileContext): RenderPlan {
  const { fps, window, frames, layout } = prepare(project, ctx)
  const { width: W, height: H } = ctx.size ?? exportSize(ctx.settings.resolution)
  const g = new Graph()
  const env: VideoEnv = {
    g,
    ctx,
    W,
    H,
    S: W / CANVAS_W,
    fps,
    scaler: SCALERS[ctx.settings.quality],
  }
  let video = buildMainTrack(env, project, layout, window)
  video = buildOverlays(env, project, video, window)
  if (ctx.assBehindPath) {
    const behind = { path: ctx.assBehindPath, fontsDir: ctx.fontsDir }
    // Without a matte there is no subject to hide behind: the text is drawn normally.
    video = hasSubject(env, project)
      ? applyBehindText(env, project, video, layout, window, behind)
      : applyText(env, video, window, behind)
  }
  video = applyText(
    env,
    video,
    window,
    ctx.assPath ? { path: ctx.assPath, fontsDir: ctx.fontsDir } : undefined,
  )
  video = finishVideo(env, video, ctx.encoder.pixFmt ?? 'yuv420p')
  const audio = buildAudio({ g, ctx, fps, analysis: false }, project, layout, window)
  const duration = durationUs(frames, fps)
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...g.inputArgs(),
    '-/filter_complex',
    ctx.filterGraphPath,
    '-map',
    `[${video}]`,
    '-map',
    `[${audio}]`,
    '-c:v',
    ctx.encoder.video,
    ...ctx.encoder.args,
    '-fps_mode',
    'cfr',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-color_range',
    'tv',
    '-c:a',
    'aac',
    '-profile:a',
    'aac_low',
    '-b:a',
    '320k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    secs(duration),
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    ctx.output,
  ]
  return {
    args,
    filterGraph: g.toString(),
    filterGraphPath: ctx.filterGraphPath,
    duration,
    frames,
    width: W,
    height: H,
  }
}

/** A loudness analysis command: audio-only decode → `loudnorm=print_format=json` → null. */
export interface AnalysisPlan {
  args: string[]
  filterGraph: string
  filterGraphPath: string
  duration: number
}

/**
 * Compile the fast first pass of a two-pass loudness normalisation: only audio streams are
 * opened (`-vn`), the same mix as the export is built, and `loudnorm` prints its
 * measurement as JSON on stderr (parse it and pass it back as `ctx.loudness`).
 * Returns undefined when the project has no audible audio.
 */
export function compileLoudnessAnalysis(
  project: Project,
  ctx: CompileContext,
): AnalysisPlan | undefined {
  const { fps, window, frames, layout } = prepare(project, ctx)
  const g = new Graph()
  const audio = buildAudio({ g, ctx, fps, analysis: true }, project, layout, window)
  if (g.inputCount === 0) return undefined
  return {
    args: [
      '-hide_banner',
      '-nostdin',
      ...g.inputArgs(),
      '-/filter_complex',
      ctx.filterGraphPath,
      '-map',
      `[${audio}]`,
      '-f',
      'null',
      '-',
    ],
    filterGraph: g.toString(),
    filterGraphPath: ctx.filterGraphPath,
    duration: durationUs(frames, fps),
  }
}
