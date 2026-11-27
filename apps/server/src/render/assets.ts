/**
 * Gathers the assets a project references, with the on-disk path of each original and the
 * colour transfer the compiler needs for HDR → SDR tone mapping.
 *
 * The probe job stores `colorTransfer`/`colorPrimaries` on the asset. Assets probed before
 * those fields existed fall back to the cached probe (`probe.json` next to the original),
 * then to a quick ffprobe of the first video stream.
 */
import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Asset, CompileAsset, Project } from '@reelforge/core'
import type { DataPaths, Store } from '../contracts.ts'
import { assetDir, assetFile } from '../paths.ts'

/** Ids of every asset referenced by the project's clips. */
export function projectAssetIds(p: Project): Set<string> {
  const ids = new Set<string>()
  for (const track of p.tracks) {
    for (const c of track.clips) {
      if (c.type === 'text') continue
      if (c.assetId) ids.add(c.assetId)
      // AI background image (clip.background.mode = 'image').
      if ((c.type === 'video' || c.type === 'image') && c.background?.assetId)
        ids.add(c.background.assetId)
    }
  }
  return ids
}

type ColorInfo = Pick<Asset, 'colorTransfer' | 'colorPrimaries'>

/** Colour fields of a parsed `probe.json` (untrusted JSON), if present. */
const pickColor = (o: unknown): ColorInfo | undefined => {
  if (typeof o !== 'object' || o === null) return undefined
  const r = o as Record<string, unknown>
  if (typeof r.colorTransfer !== 'string') return undefined
  return {
    colorTransfer: r.colorTransfer,
    colorPrimaries: typeof r.colorPrimaries === 'string' ? r.colorPrimaries : undefined,
  }
}

/** ffprobe the first video stream's colour transfer/primaries ({} when unknown). */
export function probeColor(
  ffprobe: string,
  file: string,
  signal?: AbortSignal,
): Promise<ColorInfo> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=color_transfer,color_primaries',
        '-of',
        'json',
        file,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, signal },
    )
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.once('error', () => resolve({}))
    child.once('close', () => {
      try {
        const s = (JSON.parse(out) as { streams?: Record<string, unknown>[] }).streams?.[0]
        resolve({
          colorTransfer: typeof s?.color_transfer === 'string' ? s.color_transfer : undefined,
          colorPrimaries: typeof s?.color_primaries === 'string' ? s.color_primaries : undefined,
        })
      } catch {
        resolve({})
      }
    })
  })
}

async function colorOf(
  asset: Asset,
  file: string,
  o: { paths: DataPaths; ffprobe: string; signal?: AbortSignal },
): Promise<ColorInfo> {
  if (asset.kind !== 'video') return {}
  if (asset.colorTransfer !== undefined) {
    return { colorTransfer: asset.colorTransfer, colorPrimaries: asset.colorPrimaries }
  }
  try {
    const cached = JSON.parse(
      await readFile(path.join(assetDir(o.paths, asset.id), 'probe.json'), 'utf8'),
    ) as unknown
    const info = pickColor(cached)
    if (info) return info
  } catch {
    // No cached probe: ask ffprobe.
  }
  return probeColor(o.ffprobe, file, o.signal)
}

/** Raised when a referenced asset is missing from the store or the disk. */
export class MissingAssetError extends Error {
  readonly assetId: string
  constructor(assetId: string, why: string) {
    super(`asset ${assetId} ${why}`)
    this.name = 'MissingAssetError'
    this.assetId = assetId
  }
}

/** Resolve every referenced asset to a compiler asset (path + colour info), in parallel. */
export async function collectAssets(
  p: Project,
  o: { store: Store; paths: DataPaths; ffprobe: string; signal?: AbortSignal },
): Promise<Record<string, CompileAsset>> {
  const entries = await Promise.all(
    [...projectAssetIds(p)].map(async (id): Promise<[string, CompileAsset]> => {
      const asset = o.store.getAsset(id)
      if (!asset) throw new MissingAssetError(id, 'is not in the library')
      const file = assetFile(o.paths, asset, 'original')
      try {
        await access(file)
      } catch {
        throw new MissingAssetError(id, `original is missing (${file})`)
      }
      const color = await colorOf(asset, file, o)
      return [id, { ...asset, ...color, path: file }]
    }),
  )
  return Object.fromEntries(entries)
}
