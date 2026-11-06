/**
 * Project → FFmpeg render plan. Pure: no I/O. The server writes `filterGraph` to
 * `filterGraphPath` and runs `ffmpeg ...args`.
 * STUB — implemented by the render builder.
 */
import type { Asset, ExportSettings, Project, Us } from '../schema.ts'
import type { EffectPreset } from '../packs.ts'

export interface EncoderChoice {
  /** e.g. 'h264_amf', 'hevc_nvenc', 'libx264', 'libsvtav1' */
  video: string
  /** encoder-specific args (rate control, preset, profile, gop) */
  args: string[]
}

export interface CompileContext {
  assets: Readonly<Record<string, Asset & { path: string }>>
  settings: ExportSettings
  output: string
  /** Path of the .ass file the server wrote from buildAss(); omitted if no text/captions. */
  assPath?: string
  fontsDir: string
  filterGraphPath: string
  resolveLut(ref: string): string | undefined
  resolveSticker(ref: string): string | undefined
  resolveEffect(ref: string): EffectPreset | undefined
  encoder: EncoderChoice
  /** Optional RNNoise model (.rnnn) for `arnndn`; when absent denoise uses `afftdn`. */
  rnnoiseModel?: string
}

export interface RenderPlan {
  /** Full ffmpeg argv without the binary. */
  args: string[]
  filterGraph: string
  filterGraphPath: string
  duration: Us
  frames: number
  /** Output pixel size after export scaling. */
  width: number
  height: number
}

export function compileRender(project: Project, ctx: CompileContext): RenderPlan {
  void ctx
  throw new Error(`@reelforge/core: compileRender(${project.id}) not implemented yet`)
}

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
