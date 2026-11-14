/** Canonical on-disk locations for asset files. Shared by media, render and AI modules. */
import path from 'node:path'
import type { Asset } from '@reelforge/core'
import type { DataPaths } from './contracts.ts'

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/

/** Lower-cased, sanitised extension of the uploaded file name (".bin" if unknown). */
export const assetExt = (asset: Pick<Asset, 'name'>): string => {
  const ext = path.extname(asset.name).toLowerCase()
  return SAFE_EXT.test(ext) ? ext : '.bin'
}

export const assetDir = (paths: DataPaths, assetId: string): string => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) throw new Error(`invalid asset id: ${assetId}`)
  return path.join(paths.media, assetId)
}

/**
 * Export output location for a job (`<exports>/<jobId>.mp4`). The render job writes here; the
 * download route and retention cleanup read/remove the same path.
 */
export const exportFile = (paths: DataPaths, jobId: string): string => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new Error(`invalid job id: ${jobId}`)
  return path.join(paths.exports, `${jobId}.mp4`)
}

export type AssetVariant =
  'original' | 'proxy' | 'thumbs' | 'thumbsIndex' | 'poster' | 'waveform' | 'pcm'

export const assetFile = (
  paths: DataPaths,
  asset: Pick<Asset, 'id' | 'name'>,
  variant: AssetVariant,
): string => {
  const dir = assetDir(paths, asset.id)
  switch (variant) {
    case 'original':
      return path.join(dir, `original${assetExt(asset)}`)
    case 'proxy':
      return path.join(dir, 'proxy.mp4')
    case 'thumbs':
      return path.join(dir, 'thumbs.jpg')
    case 'thumbsIndex':
      return path.join(dir, 'thumbs.json')
    case 'poster':
      return path.join(dir, 'poster.jpg')
    case 'waveform':
      return path.join(dir, 'waveform.json')
    case 'pcm':
      return path.join(dir, 'audio.f32')
  }
}
