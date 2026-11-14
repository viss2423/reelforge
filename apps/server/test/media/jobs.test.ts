/**
 * Integration tests for the platform media jobs (probe → proxy / thumbnails / waveform) with
 * real FFmpeg on lavfi-generated fixtures. Skipped (with a message) when FFmpeg is missing.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { newId, type Asset, type ServerEvent } from '@reelforge/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DataPaths } from '../../src/contracts.ts'
import type { SqliteStore } from '../../src/db/store.ts'
import type { JobQueue } from '../../src/jobs/queue.ts'
import { run } from '../../src/media/ffmpeg.ts'
import { platformJobs } from '../../src/media/jobs.ts'
import { readMediaInfo } from '../../src/media/probe.ts'
import type { ThumbsIndex } from '../../src/media/thumbnails.ts'
import type { WaveformData } from '../../src/media/waveform.ts'
import { assetDir, assetFile } from '../../src/paths.ts'
import type { PlatformToolchain } from '../../src/toolchain.ts'
import { lavfi, makeQueue, realToolchain, tempDir } from '../helpers.ts'

const tools = await realToolchain()
if (!tools) console.warn('[media jobs] FFmpeg not found — skipping media integration tests')

interface Stream {
  codec_type: string
  codec_name: string
  width?: number
  height?: number
  pix_fmt?: string
  has_b_frames?: number
  sample_rate?: string
  channels?: number
  color_transfer?: string
  side_data_list?: unknown[]
}

const ffprobe = async (t: PlatformToolchain, file: string, extra: string[] = []): Promise<any> =>
  JSON.parse(
    (
      await run(t.ffprobe, ['-v', 'error', '-print_format', 'json', ...extra, '-i', file], {
        captureStdout: true,
      })
    ).stdout.toString(),
  )

describe.skipIf(!tools)('platform media jobs (FFmpeg)', () => {
  const t = tools!
  let fixtures: string
  let ctx: Awaited<ReturnType<typeof makeQueue>>
  let store: SqliteStore
  let queue: JobQueue
  let paths: DataPaths
  const events: ServerEvent[] = []
  let cleanupFixtures: () => Promise<void>

  beforeAll(async () => {
    ;({ dir: fixtures, cleanup: cleanupFixtures } = await tempDir('rf-fixtures-'))
    const f = (name: string): string => path.join(fixtures, name)
    const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
    await Promise.all([
      // Landscape 1280×720 with a display matrix rotating it to portrait (like phone footage).
      lavfi(
        t,
        f('landscape.mp4'),
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=1280x720:r=30:d=3',
          '-f',
          'lavfi',
          '-i',
          'sine=f=440:d=3',
        ],
        [...x264, '-c:a', 'aac', '-shortest'],
      ),
      // 10-bit HLG HEVC (iPhone-style HDR), no audio.
      lavfi(
        t,
        f('hdr.mp4'),
        ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2'],
        [
          '-c:v',
          'libx265',
          '-pix_fmt',
          'yuv420p10le',
          '-x265-params',
          'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
        ],
      ),
      lavfi(t, f('tone.m4a'), ['-f', 'lavfi', '-i', 'sine=f=220:d=3'], ['-c:a', 'aac']),
      lavfi(t, f('still.png'), ['-f', 'lavfi', '-i', 'testsrc2=s=400x300'], ['-frames:v', '1']),
      // Long enough that the filmstrip must cap at 200 tiles (keyframe every second).
      lavfi(
        t,
        f('long.mp4'),
        ['-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=2:d=300'],
        [...x264, '-g', '2'],
      ),
    ])
    await run(t.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-display_rotation',
      '90',
      '-i',
      f('landscape.mp4'),
      '-c',
      'copy',
      f('rotated.mp4'),
    ])
    await writeFile(f('corrupt.mp4'), Buffer.from('definitely not a video'))

    ctx = await makeQueue([...platformJobs], { tools: t })
    ;({ store, queue, paths } = ctx)
    ctx.bus.subscribe((e) => events.push(e))
    queue.start()
  }, 120_000)

  afterAll(async () => {
    await ctx?.cleanup()
    await cleanupFixtures?.()
  })

  /** Registers a fixture as a freshly uploaded asset and runs the full job chain. */
  const ingest = async (fixture: string, mime: string): Promise<Asset> => {
    const asset: Asset = {
      id: newId('a'),
      kind: mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'image' : 'video',
      name: fixture,
      size: 1,
      mime,
      createdAt: new Date().toISOString(),
      hasAudio: false,
      hasVideo: false,
      proxy: 'pending',
      thumbnails: 'pending',
      waveform: 'pending',
    }
    await mkdir(assetDir(paths, asset.id), { recursive: true })
    await copyFile(path.join(fixtures, fixture), assetFile(paths, asset, 'original'))
    store.putAsset(asset)
    queue.enqueue('probe', { assetId: asset.id }, { assetId: asset.id })
    await queue.idle()
    return store.getAsset(asset.id)!
  }

  const jobsOf = (assetId: string) => store.listJobs({ assetId })

  it('probes rotated phone footage and builds a portrait scrubbing proxy', async () => {
    const asset = await ingest('rotated.mp4', 'video/mp4')
    expect(asset).toMatchObject({
      kind: 'video',
      width: 720,
      height: 1280,
      rotation: 270,
      fps: 30,
      hasAudio: true,
      hasVideo: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      proxy: 'ready',
      thumbnails: 'ready',
      waveform: 'ready',
    })
    expect(Math.abs(asset.duration! - 3_000_000)).toBeLessThan(100_000)
    expect(
      jobsOf(asset.id)
        .map((j) => `${j.kind}:${j.status}`)
        .sort(),
    ).toEqual(['probe:done', 'proxy:done', 'thumbnails:done', 'waveform:done'])

    const proxy = assetFile(paths, asset, 'proxy')
    const info = await ffprobe(t, proxy, ['-show_streams', '-show_format'])
    const v = (info.streams as Stream[]).find((s) => s.codec_type === 'video')!
    const a = (info.streams as Stream[]).find((s) => s.codec_type === 'audio')!
    // 720×1280 fitted into 960 on the long side, rotation baked in (no display matrix left).
    expect(v).toMatchObject({ codec_name: 'h264', width: 540, height: 960, pix_fmt: 'yuv420p' })
    expect(v.has_b_frames).toBe(0)
    expect(v.side_data_list ?? []).toEqual([])
    expect(a).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })
    // GOP 15 at 30 fps → a keyframe every 0.5 s: 0, .5, 1, 1.5, 2, 2.5.
    const keys = await ffprobe(t, proxy, [
      '-select_streams',
      'v',
      '-skip_frame',
      'nokey',
      '-show_entries',
      'frame=pts_time',
    ])
    const times = (keys.frames as Array<{ pts_time: string }>).map((fr) => Number(fr.pts_time))
    expect(times).toHaveLength(6)
    times.forEach((time, i) => expect(time).toBeCloseTo(i * 0.5, 1))
    // +faststart: the moov atom precedes mdat.
    const head = (await readFile(proxy)).subarray(0, 64 * 1024).toString('latin1')
    expect(head.indexOf('moov')).toBeGreaterThan(-1)
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat'))

    // Probe sidecar keeps the details the Asset model has no fields for.
    const media = await readMediaInfo(paths, asset.id)
    expect(media).toMatchObject({ codedWidth: 1280, codedHeight: 720, rotation: 270, vfr: false })

    // Asset events tracked every state transition.
    const states = events
      .filter((e): e is Extract<ServerEvent, { type: 'asset' }> => e.type === 'asset')
      .filter((e) => e.asset.id === asset.id)
      .map((e) => e.asset.proxy)
    expect(states).toContain('processing')
    expect(states.at(-1) === 'ready' || states.includes('ready')).toBe(true)
  })

  it('detects HLG HDR and tone-maps the proxy to SDR BT.709', async () => {
    const asset = await ingest('hdr.mp4', 'video/mp4')
    expect(asset).toMatchObject({
      kind: 'video',
      width: 640,
      height: 360,
      hasAudio: false,
      videoCodec: 'hevc',
      proxy: 'ready',
      waveform: 'not-needed',
    })
    const media = await readMediaInfo(paths, asset.id)
    expect(media).toMatchObject({
      hdr: 'hlg',
      colorTransfer: 'arib-std-b67',
      colorPrimaries: 'bt2020',
      bitDepth: 10,
    })
    const info = await ffprobe(t, assetFile(paths, asset, 'proxy'), ['-show_streams'])
    const v = (info.streams as Stream[])[0]!
    expect(v).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', color_transfer: 'bt709' })
    expect((info.streams as Stream[]).some((s) => s.codec_type === 'audio')).toBe(false)
  })

  it('makes a filmstrip sprite capped at 200 tiles with a matching index', async () => {
    const asset = await ingest('long.mp4', 'video/mp4')
    expect(asset.thumbnails).toBe('ready')
    const index = JSON.parse(
      await readFile(assetFile(paths, asset, 'thumbsIndex'), 'utf8'),
    ) as ThumbsIndex
    expect(index.count).toBe(200)
    expect(index.interval).toBe(1_500_000)
    expect(index.tileWidth).toBe(96)
    expect(index.tileHeight).toBe(54)
    expect(index.columns * index.rows).toBeGreaterThanOrEqual(index.count)
    const sprite = await ffprobe(t, assetFile(paths, asset, 'thumbs'), ['-show_streams'])
    expect(sprite.streams[0]).toMatchObject({
      codec_name: 'mjpeg',
      width: index.columns * index.tileWidth,
      height: index.rows * index.tileHeight,
    })
    const poster = await ffprobe(t, assetFile(paths, asset, 'poster'), ['-show_streams'])
    expect(poster.streams[0]).toMatchObject({ codec_name: 'mjpeg', width: 192, height: 108 })
  })

  it('handles audio-only assets: waveform peaks, waveform poster, no proxy', async () => {
    const asset = await ingest('tone.m4a', 'audio/mp4')
    expect(asset).toMatchObject({
      kind: 'audio',
      hasAudio: true,
      hasVideo: false,
      proxy: 'not-needed',
      thumbnails: 'ready',
      waveform: 'ready',
    })
    const wf = JSON.parse(
      await readFile(assetFile(paths, asset, 'waveform'), 'utf8'),
    ) as WaveformData
    expect(wf.bucketUs).toBe(10_000)
    // 3 s of audio in 10 ms buckets (AAC priming may add a frame).
    expect(wf.count).toBeGreaterThanOrEqual(299)
    expect(wf.count).toBeLessThanOrEqual(305)
    expect(wf.peaks).toHaveLength(wf.count * 2)
    for (let i = 0; i < wf.peaks.length; i += 2) {
      expect(wf.peaks[i]!).toBeLessThanOrEqual(wf.peaks[i + 1]!)
      expect(wf.peaks[i]!).toBeGreaterThanOrEqual(-128)
      expect(wf.peaks[i + 1]!).toBeLessThanOrEqual(127)
    }
    // lavfi sine has amplitude 1/8 → |peak| ≈ 16 in int8 for a steady-state bucket.
    const mid = wf.peaks[(wf.count >> 1) * 2 + 1]!
    expect(mid).toBeGreaterThan(10)
    expect(mid).toBeLessThan(24)
    const index = JSON.parse(await readFile(assetFile(paths, asset, 'thumbsIndex'), 'utf8'))
    expect(index).toMatchObject({ count: 1, columns: 1, rows: 1 })
    const poster = await ffprobe(t, assetFile(paths, asset, 'poster'), ['-show_streams'])
    expect(poster.streams[0]).toMatchObject({ width: 640, height: 360 })
  })

  it('handles still images: thumbnails only', async () => {
    const asset = await ingest('still.png', 'image/png')
    expect(asset).toMatchObject({
      kind: 'image',
      width: 400,
      height: 300,
      hasAudio: false,
      proxy: 'not-needed',
      thumbnails: 'ready',
      waveform: 'not-needed',
    })
    expect(asset.duration).toBeUndefined()
    const index = JSON.parse(await readFile(assetFile(paths, asset, 'thumbsIndex'), 'utf8'))
    expect(index).toMatchObject({ count: 1, tileWidth: 96, tileHeight: 72 })
  })

  it('marks every derived state failed when the file cannot be probed', async () => {
    const asset = await ingest('corrupt.mp4', 'video/mp4')
    expect(asset).toMatchObject({ proxy: 'failed', thumbnails: 'failed', waveform: 'failed' })
    const [job] = jobsOf(asset.id)
    expect(job).toMatchObject({ kind: 'probe', status: 'failed' })
    expect(job!.error).toBeTruthy()
  })

  it('cancelling a running proxy resets its state to pending', async () => {
    const asset = await ingest('long.mp4', 'video/mp4')
    // Re-run the proxy and cancel it as soon as it starts.
    const job = queue.enqueue('proxy', { assetId: asset.id }, { assetId: asset.id })
    const off = ctx.bus.subscribe((e) => {
      if (e.type === 'job' && e.job.id === job.id && e.job.status === 'running')
        queue.cancel(job.id)
    })
    await queue.idle()
    off()
    expect(store.getJob(job.id)?.status).toBe('cancelled')
    expect(store.getAsset(asset.id)?.proxy).toBe('pending')
  })
})
