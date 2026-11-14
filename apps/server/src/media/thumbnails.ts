/**
 * Timeline filmstrip sprite + poster frame.
 *
 * The sprite is ONE JPEG of up to 200 tiles (~96 px wide, source aspect) laid out in a grid,
 * described by `thumbs.json`. One image = one request and one decode on the client, which
 * keeps timeline scrolling cheap.
 *
 * Speed: when the source has a keyframe at least every two tile intervals (phones write one
 * every 1–2 s), frames are taken from keyframes only (`-skip_frame nokey`), so FFmpeg decodes
 * a tiny fraction of the video. Keyframe spacing is read from the packet index first (demux
 * only, no decoding); sources with sparse keyframes (screen recordings, edited exports with
 * huge GOPs) are fully decoded instead so every tile shows its own moment.
 */
import { rename, rm, writeFile } from 'node:fs/promises'
import { FFMPEG_BASE, run } from './ffmpeg.ts'
import { fitEven, tonemapFilter } from './filters.ts'
import type { MediaInfo } from './probe.ts'
import type { ToolchainExtras } from './proxy.ts'

/** Layout of `thumbs.jpg`, served as `thumbs.json`. Times in microseconds. */
export interface ThumbsIndex {
  /** Time between tiles (tile i shows time i * interval). */
  interval: number
  columns: number
  rows: number
  tileWidth: number
  tileHeight: number
  count: number
}

export const MAX_TILES = 200
export const TILE_WIDTH = 96
const MAX_COLUMNS = 10
const MIN_INTERVAL_US = 500_000
const POSTER_LONG_SIDE = 720

/** Chooses tile interval/count/grid so that there are at most MAX_TILES tiles. */
export const thumbsLayout = (durationUs: number, width: number, height: number): ThumbsIndex => {
  // Interval rounded up to 0.1 s so tile times are readable and stable.
  const interval = Math.max(MIN_INTERVAL_US, Math.ceil(durationUs / MAX_TILES / 100_000) * 100_000)
  const count = Math.max(1, Math.min(MAX_TILES, Math.ceil(durationUs / interval)))
  const columns = Math.min(count, MAX_COLUMNS)
  const tileHeight = Math.max(2, Math.round((TILE_WIDTH * height) / width / 2) * 2)
  return {
    interval,
    columns,
    rows: Math.ceil(count / columns),
    tileWidth: TILE_WIDTH,
    tileHeight,
    count,
  }
}

const jpegOut = (output: string, quality: number): string[] => [
  '-frames:v',
  '1',
  '-q:v',
  String(quality),
  '-update',
  '1',
  '-f',
  'image2',
  output,
]

/**
 * Largest distance between consecutive keyframes of a video stream (including from the last
 * keyframe to the end), in microseconds. Reads packet flags only — no decoding — streaming
 * ffprobe's CSV so memory stays constant for hour-long files.
 */
export const maxKeyframeGap = async (
  ffprobe: string,
  input: string,
  streamIndex: number,
  durationUs: number,
  signal?: AbortSignal,
): Promise<number> => {
  let prev = -1
  let gap = 0
  let rest = ''
  const line = (l: string): void => {
    // "<pts_time>,<dts_time>,<flags>" e.g. "1.001000,0.967633,K__"
    const [pts, dts, flags] = l.split(',')
    if (!flags?.includes('K')) return
    const t = Number(pts === 'N/A' ? dts : pts)
    if (!Number.isFinite(t)) return
    const us = Math.round(t * 1_000_000)
    gap = Math.max(gap, prev < 0 ? us : us - prev)
    prev = us
  }
  await run(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      String(streamIndex),
      '-show_entries',
      'packet=pts_time,dts_time,flags',
      '-of',
      'csv=p=0',
      '-i',
      input,
    ],
    {
      timeoutMs: 60_000,
      ...(signal ? { signal } : {}),
      onStdout: (chunk) => {
        const lines = (rest + chunk.toString('latin1')).split('\n')
        rest = lines.pop()!
        for (const l of lines) line(l.trim())
      },
    },
  )
  line(rest.trim())
  return prev < 0 ? durationUs : Math.max(gap, durationUs - prev)
}

/**
 * FFmpeg argv for the filmstrip sprite of a video. `keyframesOnly` decodes only keyframes
 * (only valid when they are dense enough — see `maxKeyframeGap`). Pure (unit-tested).
 */
export const spriteArgs = (
  info: MediaInfo,
  input: string,
  output: string,
  layout: ThumbsIndex,
  keyframesOnly: boolean,
): string[] => {
  const tonemap = tonemapFilter(info)
  const vf = [
    `fps=${(1_000_000 / layout.interval).toFixed(6)}`,
    `scale=${layout.tileWidth}:${layout.tileHeight}:flags=fast_bilinear`,
    tonemap,
    'format=yuv420p',
    `tile=${layout.columns}x${layout.rows}`,
  ]
    .filter(Boolean)
    .join(',')
  return [
    ...FFMPEG_BASE,
    ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []),
    '-i',
    input,
    '-map',
    `0:${info.videoStreamIndex ?? 0}`,
    '-vf',
    vf,
    ...jpegOut(output, 5),
  ]
}

/** FFmpeg argv for the poster frame (≤ 720 px long side). Pure (unit-tested). */
export const posterArgs = (info: MediaInfo, input: string, output: string): string[] => {
  const size = fitEven(
    info.width ?? POSTER_LONG_SIDE,
    info.height ?? POSTER_LONG_SIDE,
    POSTER_LONG_SIDE,
  )
  const vf = [`scale=${size.width}:${size.height}`, tonemapFilter(info), 'format=yuv420p']
    .filter(Boolean)
    .join(',')
  const args = [...FFMPEG_BASE]
  // Skip the (often black) first frame of videos: 10 % in, at most 1 s.
  if (info.kind === 'video' && info.duration)
    args.push('-ss', (Math.min(1_000_000, info.duration * 0.1) / 1_000_000).toFixed(3))
  args.push(
    '-i',
    input,
    '-map',
    `0:${info.videoStreamIndex ?? 0}`,
    '-vf',
    vf,
    ...jpegOut(output, 3),
  )
  return args
}

/** Waveform picture used as poster + single-tile sprite for audio-only assets. */
const audioArgs = (
  info: MediaInfo,
  input: string,
  poster: string,
  sprite: string,
  layout: ThumbsIndex,
): string[] => [
  ...FFMPEG_BASE,
  '-i',
  input,
  '-filter_complex',
  `[0:${info.audioStreamIndex ?? 0}]aformat=channel_layouts=mono,showwavespic=s=640x360:colors=0xE5E7EB,format=yuv420p,split[p][s];[s]scale=${layout.tileWidth}:${layout.tileHeight}[t]`,
  '-map',
  '[p]',
  ...jpegOut(poster, 3),
  '-map',
  '[t]',
  ...jpegOut(sprite, 5),
]

/** Generates `thumbs.jpg`, `thumbs.json` and `poster.jpg` (atomically renamed into place). */
export const makeThumbnails = async (opts: {
  tools: ToolchainExtras
  info: MediaInfo
  input: string
  sprite: string
  index: string
  poster: string
  signal: AbortSignal
}): Promise<ThumbsIndex> => {
  const { tools, info, input, signal } = opts
  const tmp = (f: string): string => `${f}.part.jpg`
  const sprite = tmp(opts.sprite)
  const poster = tmp(opts.poster)
  let layout: ThumbsIndex
  try {
    if (info.kind === 'audio') {
      layout = { ...thumbsLayout(info.duration ?? 1, 16, 9), count: 1, columns: 1, rows: 1 }
      layout.interval = Math.max(1, info.duration ?? 1)
      await run(tools.ffmpeg, audioArgs(info, input, poster, sprite, layout), {
        signal,
        lowPriority: true,
      })
    } else {
      const w = info.width ?? 16
      const h = info.height ?? 9
      layout =
        info.kind === 'image'
          ? { ...thumbsLayout(1, w, h), count: 1, columns: 1, rows: 1 }
          : thumbsLayout(info.duration ?? 1, w, h)
      const keyframesOnly =
        info.kind === 'video' &&
        (await maxKeyframeGap(
          tools.ffprobe,
          input,
          info.videoStreamIndex ?? 0,
          info.duration ?? 0,
          signal,
        )) <=
          2 * layout.interval
      const spriteCmd =
        info.kind === 'image'
          ? [
              ...FFMPEG_BASE,
              '-i',
              input,
              '-vf',
              `scale=${layout.tileWidth}:${layout.tileHeight},format=yuv420p`,
              ...jpegOut(sprite, 5),
            ]
          : spriteArgs(info, input, sprite, layout, keyframesOnly)
      // Sprite and poster decode different parts of the file; run them concurrently.
      await Promise.all([
        run(tools.ffmpeg, spriteCmd, { signal, lowPriority: true }),
        run(tools.ffmpeg, posterArgs(info, input, poster), { signal, lowPriority: true }),
      ])
    }
    await rename(sprite, opts.sprite)
    await rename(poster, opts.poster)
    await writeFile(`${opts.index}.part`, JSON.stringify(layout))
    await rename(`${opts.index}.part`, opts.index)
    return layout
  } finally {
    await Promise.all([rm(sprite, { force: true }), rm(poster, { force: true })])
  }
}
