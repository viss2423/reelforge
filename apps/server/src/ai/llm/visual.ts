/**
 * Visual statistics per thumbnail tile (the sprite the media pipeline already made), so
 * footage without speech can still be ranked: exposure, contrast, detail and motion
 * between neighbouring tiles. One tiny FFmpeg decode (gray, ≤ 960 px wide) per asset.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { Asset } from '@reelforge/core'
import type { DataPaths } from '../../contracts.ts'
import { assetFile } from '../../paths.ts'
import { run } from '../proc.ts'
import type { VisualStats } from './segments.ts'

interface ThumbsIndex {
  interval: number
  columns: number
  rows: number
  tileWidth: number
  tileHeight: number
  count: number
}

/** Stats of tile `k` of a gray sprite (`w` px wide). Exported for tests. */
export const tileStats = (
  gray: Uint8Array,
  w: number,
  ix: ThumbsIndex,
  k: number,
): Omit<VisualStats, 'motion'> & { pixels: Float32Array } => {
  const tx = (k % ix.columns) * ix.tileWidth
  const ty = Math.floor(k / ix.columns) * ix.tileHeight
  const n = ix.tileWidth * ix.tileHeight
  const pixels = new Float32Array(n)
  let sum = 0
  for (let y = 0; y < ix.tileHeight; y++)
    for (let x = 0; x < ix.tileWidth; x++) {
      const v = (gray[(ty + y) * w + tx + x] ?? 0) / 255
      pixels[y * ix.tileWidth + x] = v
      sum += v
    }
  const mean = sum / n
  let varSum = 0
  let grad = 0
  for (let y = 0; y < ix.tileHeight; y++)
    for (let x = 0; x < ix.tileWidth; x++) {
      const v = pixels[y * ix.tileWidth + x]!
      varSum += (v - mean) ** 2
      if (x + 1 < ix.tileWidth && y + 1 < ix.tileHeight) {
        grad +=
          Math.abs(pixels[y * ix.tileWidth + x + 1]! - v) +
          Math.abs(pixels[(y + 1) * ix.tileWidth + x]! - v)
      }
    }
  return {
    brightness: mean,
    contrast: Math.sqrt(varSum / n),
    sharpness: grad / (2 * Math.max(1, (ix.tileWidth - 1) * (ix.tileHeight - 1))),
    pixels,
  }
}

/** Per-tile stats from a decoded gray sprite. */
export const spriteStats = (
  gray: Uint8Array,
  w: number,
  ix: ThumbsIndex,
): Array<{ t: number } & VisualStats> => {
  const out: Array<{ t: number } & VisualStats> = []
  let prev: Float32Array | undefined
  for (let k = 0; k < ix.count; k++) {
    const s = tileStats(gray, w, ix, k)
    let motion = 0
    if (prev) {
      let d = 0
      for (let i = 0; i < s.pixels.length; i++) d += Math.abs(s.pixels[i]! - prev[i]!)
      motion = d / s.pixels.length
    }
    prev = s.pixels
    out.push({
      t: k * ix.interval,
      brightness: s.brightness,
      contrast: s.contrast,
      sharpness: s.sharpness,
      motion,
    })
  }
  // The first tile has no predecessor: borrow the next tile's motion.
  if (out.length > 1) out[0]!.motion = out[1]!.motion
  return out
}

/** Decodes the asset's thumbnail sprite and returns per-tile stats (undefined if absent). */
export const assetVisualStats = async (
  ffmpeg: string,
  paths: DataPaths,
  asset: Pick<Asset, 'id' | 'name'>,
  signal?: AbortSignal,
): Promise<Array<{ t: number } & VisualStats> | undefined> => {
  const jpg = assetFile(paths, asset, 'thumbs')
  const json = assetFile(paths, asset, 'thumbsIndex')
  if (!existsSync(jpg) || !existsSync(json)) return undefined
  let ix: ThumbsIndex
  try {
    ix = JSON.parse(readFileSync(json, 'utf8')) as ThumbsIndex
  } catch {
    return undefined
  }
  const w = ix.columns * ix.tileWidth
  const chunks: Buffer[] = []
  const r = await run(
    ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      jpg,
      '-vf',
      `crop=${w}:${ix.rows * ix.tileHeight}:0:0`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { ...(signal ? { signal } : {}), onStdoutData: (c) => void chunks.push(c) },
  )
  if (r.code !== 0) return undefined
  const gray = new Uint8Array(Buffer.concat(chunks))
  if (gray.length < w * ix.rows * ix.tileHeight) return undefined
  return spriteStats(gray, w, ix)
}
