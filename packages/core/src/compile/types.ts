/** Public types of the render compiler (re-exported from `compile/index.ts`). */
import type { Asset, ExportSettings, Us } from '../schema.ts'
import type { AnimationPreset, EffectPreset } from '../packs.ts'

export interface EncoderChoice {
  /** e.g. 'h264_amf', 'hevc_nvenc', 'libx264', 'libsvtav1' */
  video: string
  /** encoder-specific args (rate control, preset, profile, gop) */
  args: string[]
  /**
   * Pixel format the encoder wants (default `yuv420p`). The graph's final `format` filter
   * produces it directly so FFmpeg never inserts an extra conversion before the encoder.
   */
  pixFmt?: string
}

/** Measured loudness from a `loudnorm=print_format=json` analysis pass (2nd-pass input). */
export interface LoudnessMeasurement {
  /** input_i (LUFS) */
  I: number
  /** input_tp (dBTP) */
  TP: number
  /** input_lra (LU) */
  LRA: number
  /** input_thresh (LUFS) */
  thresh: number
  /** target_offset (LU) */
  offset: number
}

/** An asset as the compiler sees it: probe data (incl. colour transfer) + path of the original. */
export type CompileAsset = Asset & { path: string }

export interface CompileContext {
  assets: Readonly<Record<string, CompileAsset>>
  settings: ExportSettings
  output: string
  /** Path of the .ass file the server wrote from buildAss(); omitted if no text/captions. */
  assPath?: string
  /**
   * `.ass` with only the "behind subject" text clips (buildAss `layer: 'behind'`); drawn
   * under the main track's matte-cut subject. When set, `assPath` holds the other text
   * (`layer: 'front'`). Ignored (and the server should use `layer: 'all'`) without mattes.
   */
  assBehindPath?: string
  /** Subject matte video (gray, display orientation, source timing) of an asset, if ready. */
  resolveMatte?(assetId: string): string | undefined
  fontsDir: string
  filterGraphPath: string
  resolveLut(ref: string): string | undefined
  resolveSticker(ref: string): string | undefined
  resolveEffect(ref: string): EffectPreset | undefined
  encoder: EncoderChoice
  /** Optional RNNoise model (.rnnn) for `arnndn`; when absent denoise uses `afftdn`. */
  rnnoiseModel?: string
  /**
   * Optional: a `.cube` with the LUT pre-blended with identity at `intensity`, so partial
   * LUT strength costs one `lut3d` instead of split + lut3d + blend.
   */
  resolveLutMix?(ref: string, intensity: number): string | undefined
  /** Optional: animation presets for sticker in/out animations (`builtin/…` or pack refs). */
  resolveAnimation?(ref: string): AnimationPreset | undefined
  /** Measured loudness for a 2-pass `loudnorm`; absent → single-pass dynamic loudnorm. */
  loudness?: LoudnessMeasurement
  /** Override the output size (e.g. 540×960 previews); default `exportSize(resolution)`. */
  size?: { width: number; height: number }
  /** Optional `-hwaccel` for video decoding (e.g. `d3d11va`); FFmpeg falls back to software. */
  hwaccel?: string
  /**
   * Restrict {@link hwaccel} to sources with these ffprobe codec names (e.g. `hevc`): hardware
   * decoding only pays off where software decoding is the bottleneck, since decoded frames
   * are copied back to system memory for the filter graph. Unset = every video source.
   */
  hwaccelCodecs?: readonly string[]
}

/** The `-hwaccel` to request for a source asset under `ctx` (undefined = software decode). */
export function hwaccelFor(
  ctx: Pick<CompileContext, 'hwaccel' | 'hwaccelCodecs'>,
  asset: Pick<Asset, 'videoCodec'> | undefined,
): string | undefined {
  if (!ctx.hwaccel) return undefined
  if (!ctx.hwaccelCodecs) return ctx.hwaccel
  const codec = asset?.videoCodec
  return codec !== undefined && ctx.hwaccelCodecs.includes(codec) ? ctx.hwaccel : undefined
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
