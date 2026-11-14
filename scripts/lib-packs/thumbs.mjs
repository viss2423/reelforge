/**
 * Thumbnail generation (WebP) for filters, caption styles, text presets and templates.
 *
 * Everything is rendered by the real toolchain — FFmpeg `lut3d` for looks and libass (via
 * the `ass` filter) with the pack fonts for text — on the procedural test scene, so a
 * thumbnail is an honest preview of what export produces. Jobs run in a small process pool
 * (one FFmpeg per core); each encode is `-flags +bitexact` so a given FFmpeg build
 * produces byte-identical files.
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { CaptionStyle, TextStyle } from '../../packages/core/src/index.ts'
import { captionPreviewAss, textPreviewAss } from './ass-preview.mjs'
import { SCENE_H, SCENE_W, drawScene } from './scene.mjs'

/** Thumbnail sizes (9:16 for full-frame previews, 9:5 bands for text). */
export const FRAME_THUMB = { w: 216, h: 384 }
export const TEXT_THUMB = { w: 360, h: 200 }

/** Relative thumb path for an item of a given kind (kinds share one folder per pack). */
export const thumbPath = (kind, id) => `thumbs/${kind}-${id}.webp`

/** Run ffmpeg, rejecting with its stderr on failure. */
export function ffmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${args.join(' ')}\n${stderr}`)),
    )
  })
}

/** Run async tasks with at most `limit` in flight; rejects on the first failure. */
export async function pool(tasks, limit = availableParallelism()) {
  let next = 0
  const worker = async () => {
    // Sequential by design: each worker pulls the next task only when its previous one ends,
    // which is what bounds concurrency to `limit`.
    // oxlint-disable-next-line no-await-in-loop
    while (next < tasks.length) await tasks[next++]()
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}

const WEBP = ['-c:v', 'libwebp', '-quality', '78', '-compression_level', '6']
const BITEXACT = ['-flags', '+bitexact', '-fflags', '+bitexact', '-map_metadata', '-1']

/**
 * Filter chain for a text preview: render `ass` over a slightly darkened scene (the preview
 * is about the type, not the backdrop), then crop a band centred on canvas y (1920-space).
 */
function textChain(ass, y) {
  const h = Math.round((SCENE_W * TEXT_THUMB.h) / TEXT_THUMB.w)
  const top = Math.max(0, Math.min(SCENE_H - h, Math.round(y / 2 - h / 2)))
  return [
    `eq=brightness=-0.1:saturation=0.85`,
    `ass=${ass}:fontsdir=fonts`,
    `crop=${SCENE_W}:${h}:0:${top}`,
    `scale=${TEXT_THUMB.w}:${TEXT_THUMB.h}:flags=lanczos`,
  ].join(',')
}

/**
 * Regenerate every thumbnail of every pack.
 *
 * Planning is synchronous (it only builds file lists and filtergraphs); the temp inputs are
 * then staged concurrently and the encodes run on the process pool.
 * @param {{ manifests: { dir: string, manifest: any }[], fontFiles: string[] }} opts
 *   `manifests` are raw pack.json objects; `fontFiles` absolute .ttf paths (flattened for
 *   libass, whose `fontsdir` is not recursive).
 * @returns {Promise<number>} number of thumbnails written
 */
export async function generateThumbs({ manifests, fontFiles }) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'reelforge-thumbs-'))
  try {
    // Temp-dir inputs, keyed by name relative to `tmp`: generated content, and copied files.
    const writes = new Map([['scene.png', drawScene().toPNG()]])
    const copies = new Map(fontFiles.map((f) => [`fonts/${path.basename(f)}`, f]))

    // LUTs are copied into the temp dir under short names: absolute Windows paths (drive
    // colon, spaces) would need fragile escaping inside an FFmpeg filtergraph.
    const lutFile = new Map()
    const lutFor = (ref) => {
      let name = lutFile.get(ref)
      if (!name) {
        const [packId, id] = ref.split('/')
        const pack = manifests.find((m) => m.manifest.id === packId)
        const preset = pack?.manifest.filters?.find((f) => f.id === id)
        if (!preset) throw new Error(`unknown filter ref ${ref}`)
        name = `lut-${lutFile.size}.cube`
        copies.set(name, path.join(pack.dir, preset.lut))
        lutFile.set(ref, name)
      }
      return name
    }
    let n = 0
    const stageAss = (prefix, text) => {
      const name = `${prefix}-${n++}.ass`
      writes.set(name, text)
      return name
    }

    /** One FFmpeg encode per thumbnail: [filtergraph, absolute output path]. */
    const encodes = []
    for (const { dir, manifest } of manifests) {
      const out = (kind, id) => path.join(dir, thumbPath(kind, id))
      for (const f of manifest.filters ?? []) {
        const lut = lutFor(`${manifest.id}/${f.id}`)
        encodes.push([
          `lut3d=file=${lut}:interp=tetrahedral,scale=${FRAME_THUMB.w}:${FRAME_THUMB.h}:flags=lanczos`,
          out('filter', f.id),
        ])
      }
      for (const cs of manifest.captionStyles ?? []) {
        const style = CaptionStyle.parse(cs.style)
        const ass = stageAss('caption', captionPreviewAss(style))
        encodes.push([textChain(ass, style.y), out('caption', cs.id)])
      }
      for (const tp of manifest.textPresets ?? []) {
        const style = TextStyle.parse(tp.style)
        const ass = stageAss('text', textPreviewAss(style, tp.sampleText ?? 'Your text'))
        encodes.push([textChain(ass, 960), out('text', tp.id)])
      }
      for (const t of manifest.templates ?? []) {
        const first = t.slots.find((s) => s.text) ?? t.slots[0]
        const filters = []
        const filterRef = t.slots.find((s) => s.filter)?.filter
        if (filterRef) filters.push(`lut3d=file=${lutFor(filterRef)}:interp=tetrahedral`)
        const presetRef = first?.text?.preset
        const preset = presetRef ? findTextPreset(manifests, presetRef) : undefined
        if (preset) {
          const style = TextStyle.parse(preset.style)
          const ass = stageAss('template', textPreviewAss(style, first.text.text, 760))
          filters.push(`ass=${ass}:fontsdir=fonts`)
        }
        filters.push(`scale=${FRAME_THUMB.w}:${FRAME_THUMB.h}:flags=lanczos`)
        encodes.push([filters.join(','), out('template', t.id)])
      }
    }

    await mkdir(path.join(tmp, 'fonts'))
    await Promise.all([
      ...[...writes].map(([name, data]) => writeFile(path.join(tmp, name), data)),
      ...[...copies].map(([name, src]) => copyFile(src, path.join(tmp, name))),
      // Start from empty thumbs folders so removed items leave no orphans behind.
      ...manifests.map(async ({ dir }) => {
        const thumbs = path.join(dir, 'thumbs')
        await rm(thumbs, { recursive: true, force: true })
        await mkdir(thumbs, { recursive: true })
      }),
    ])
    await pool(
      encodes.map(
        ([vf, file]) =>
          () =>
            ffmpeg(['-i', 'scene.png', '-vf', vf, ...WEBP, ...BITEXACT, file], tmp),
      ),
    )
    return encodes.length
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function findTextPreset(manifests, ref) {
  const [packId, id] = ref.split('/')
  return manifests
    .find((m) => m.manifest.id === packId)
    ?.manifest.textPresets?.find((p) => p.id === id)
}

/** List `.ttf` files under the fonts dir (one level of family folders), sorted. */
export async function listFontFiles(fontsDir) {
  const families = (await readdir(fontsDir, { withFileTypes: true })).filter((d) => d.isDirectory())
  const perFamily = await Promise.all(
    families.map(async (family) => {
      const dir = path.join(fontsDir, family.name)
      return (await readdir(dir))
        .filter((f) => f.toLowerCase().endsWith('.ttf'))
        .map((f) => path.join(dir, f))
    }),
  )
  return perFamily.flat().toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
