/**
 * Subject-matting models. Every entry is an ONNX network that maps one RGB frame to a
 * per-pixel foreground probability/alpha. Weights are fetched by `pnpm bootstrap`
 * (scripts/lib/matte.ts) into `<data>/models/matte/<file>` with pinned SHA-256.
 *
 * Shipped (see README.md for the benchmark that picked them):
 * - `modnet` MODNet portrait matting, Apache-2.0 (BiRefNet/BEN2 were benchmarked and rejected:
 *   30 s per frame on this CPU, DirectML out of memory).
 */
import path from 'node:path'
import type { DataPaths } from '../../contracts.ts'

export type MatteModelId = 'modnet'

export interface MatteModelSpec {
  id: MatteModelId
  /** File name under `<data>/models/matte/`. */
  file: string
  label: string
  license: string
  /**
   * Network input size: a fixed square/rectangle, or the frame scaled so its short side is
   * `short` px, both sides rounded to a multiple of `align` (fully convolutional nets).
   */
  input:
    | { kind: 'fixed'; width: number; height: number }
    | { kind: 'short'; short: number; align: number }
  /** Per-channel normalisation of 0..1 RGB: (x - mean) / std. */
  mean: readonly [number, number, number]
  std: readonly [number, number, number]
  /** The output is a logit (apply a sigmoid) rather than a 0..1 alpha. */
  logits: boolean
}

export const MATTE_MODELS: Readonly<Record<MatteModelId, MatteModelSpec>> = {
  modnet: {
    id: 'modnet',
    file: 'modnet.onnx',
    label: 'Fast (MODNet)',
    license: 'Apache-2.0',
    input: { kind: 'short', short: 512, align: 32 },
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    logits: false,
  },
}

export const MATTE_MODEL_IDS = Object.keys(MATTE_MODELS) as MatteModelId[]

/** Directory holding the matting models. */
export const matteModelDir = (paths: DataPaths): string => path.join(paths.models, 'matte')

export const matteModelPath = (paths: DataPaths, id: MatteModelId): string =>
  path.join(matteModelDir(paths), MATTE_MODELS[id].file)

const roundTo = (v: number, align: number): number => Math.max(align, Math.round(v / align) * align)

/** Network input size for a frame of `width`×`height`. */
export const inputSize = (
  spec: Pick<MatteModelSpec, 'input'>,
  width: number,
  height: number,
): { width: number; height: number } => {
  const i = spec.input
  if (i.kind === 'fixed') return { width: i.width, height: i.height }
  const s = i.short / Math.min(width, height)
  return { width: roundTo(width * s, i.align), height: roundTo(height * s, i.align) }
}
