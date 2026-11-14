/** Pure helpers of the media pipeline: probe parsing, layouts, argv builders, peak folding. */
import { describe, expect, it } from 'vitest'
import { fitEven, proxyEncoders, tonemapFilter } from '../../src/media/filters.ts'
import {
  assetFieldsFromInfo,
  parseProbe,
  streamRotation,
  type MediaInfo,
} from '../../src/media/probe.ts'
import { proxyArgs } from '../../src/media/proxy.ts'
import { MAX_TILES, spriteArgs, thumbsLayout } from '../../src/media/thumbnails.ts'
import { PeakAccumulator } from '../../src/media/waveform.ts'

const video = (over: Record<string, unknown> = {}) => ({
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  pix_fmt: 'yuv420p',
  avg_frame_rate: '30/1',
  r_frame_rate: '30/1',
  ...over,
})
const audio = {
  index: 1,
  codec_type: 'audio',
  codec_name: 'aac',
  channels: 2,
  sample_rate: '44100',
}

describe('parseProbe', () => {
  it('normalises a typical phone video', () => {
    const info = parseProbe({
      streams: [
        video({
          codec_name: 'hevc',
          pix_fmt: 'yuv420p10le',
          color_transfer: 'smpte2084',
          color_primaries: 'bt2020',
          color_space: 'bt2020nc',
          avg_frame_rate: '30000/1001',
          r_frame_rate: '30000/1001',
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
        }),
        audio,
      ],
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '12.345678',
        start_time: '0.000000',
      },
    })
    expect(info).toMatchObject({
      kind: 'video',
      duration: 12_345_678,
      width: 1080,
      height: 1920,
      codedWidth: 1920,
      codedHeight: 1080,
      rotation: 90,
      fps: 29.97,
      fpsRational: '30000/1001',
      vfr: false,
      bitDepth: 10,
      hdr: 'pq',
      hasVideo: true,
      hasAudio: true,
      audioChannels: 2,
      audioSampleRate: 44_100,
      videoStreamIndex: 0,
      audioStreamIndex: 1,
    })
  })

  it('flags variable frame rate when avg and r frame rates disagree', () => {
    const info = parseProbe({
      streams: [video({ avg_frame_rate: '2997/100', r_frame_rate: '60/1' })],
      format: { duration: '1' },
    })
    expect(info.vfr).toBe(true)
    expect(info.fps).toBe(29.97)
  })

  it('ignores cover-art streams and classifies audio files', () => {
    const info = parseProbe({
      streams: [
        { ...audio, index: 0 },
        video({ index: 1, codec_name: 'mjpeg', disposition: { attached_pic: 1 } }),
      ],
      format: { format_name: 'mp3', duration: '200.5' },
    })
    expect(info).toMatchObject({
      kind: 'audio',
      hasVideo: false,
      hasAudio: true,
      duration: 200_500_000,
    })
    expect(info.width).toBeUndefined()
  })

  it('classifies stills by container, MIME hint, or single-frame streams', () => {
    const png = parseProbe({
      streams: [video({ codec_name: 'png' })],
      format: { format_name: 'png_pipe' },
    })
    expect(png).toMatchObject({ kind: 'image', hasVideo: false, hasAudio: false })
    expect(png.duration).toBeUndefined()
    const heic = parseProbe(
      {
        streams: [video({ codec_name: 'hevc' })],
        format: { format_name: 'mov,mp4', duration: '0.04' },
      },
      'image/heic',
    )
    expect(heic.kind).toBe('image')
    const single = parseProbe({
      streams: [video({ nb_frames: '1' })],
      format: { format_name: 'matroska', duration: '0.033' },
    })
    expect(single.kind).toBe('image')
  })

  it('rejects files without audio or video', () => {
    expect(() => parseProbe({ streams: [{ index: 0, codec_type: 'data' }] })).toThrow(
      /no audio or video/,
    )
    expect(() => parseProbe({})).toThrow(/no audio or video/)
  })

  it('tolerates garbage rational and duration values', () => {
    const info = parseProbe({
      streams: [video({ avg_frame_rate: '0/0', r_frame_rate: '25/1', duration: 'N/A' })],
      format: { duration: 'N/A' },
    })
    expect(info.fps).toBe(25)
    expect(info.fpsRational).toBe('25/1')
    expect(info.duration).toBeUndefined()
    expect(info.vfr).toBe(false)
  })

  it('maps probe info onto Asset fields', () => {
    const info = parseProbe({ streams: [video(), audio], format: { duration: '2' } })
    expect(assetFieldsFromInfo(info)).toEqual({
      kind: 'video',
      hasAudio: true,
      hasVideo: true,
      rotation: 0,
      duration: 2_000_000,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
    })
  })
})

describe('streamRotation', () => {
  it.each([
    [{ side_data_list: [{ rotation: 90 }] }, 270],
    [{ side_data_list: [{ rotation: -90 }] }, 90],
    [{ side_data_list: [{ rotation: 180 }] }, 180],
    [{ side_data_list: [{ rotation: -179.9 }] }, 180],
    [{ tags: { rotate: '90' } }, 90],
    [{ tags: { rotate: 'nonsense' } }, 0],
    [{}, 0],
  ])('%j → %i', (stream, expected) => {
    expect(streamRotation({ index: 0, ...stream })).toBe(expected)
  })
})

describe('thumbsLayout', () => {
  it('uses 0.5 s tiles for short clips', () => {
    expect(thumbsLayout(3_000_000, 1080, 1920)).toEqual({
      interval: 500_000,
      count: 6,
      columns: 6,
      rows: 1,
      tileWidth: 96,
      tileHeight: 170,
    })
  })

  it('never exceeds MAX_TILES and keeps the grid big enough', () => {
    for (const d of [1, 499_999, 60_000_000, 100_000_000, 3_600_000_000, 36_000_000_000]) {
      const l = thumbsLayout(d, 1920, 1080)
      expect(l.count).toBeGreaterThanOrEqual(1)
      expect(l.count).toBeLessThanOrEqual(MAX_TILES)
      expect(l.columns * l.rows).toBeGreaterThanOrEqual(l.count)
      expect(l.count * l.interval).toBeGreaterThanOrEqual(d)
      expect(l.tileHeight % 2).toBe(0)
    }
  })
})

const baseInfo: MediaInfo = {
  kind: 'video',
  duration: 10_000_000,
  width: 1080,
  height: 1920,
  rotation: 0,
  fps: 30,
  fpsRational: '30/1',
  vfr: false,
  videoStreamIndex: 0,
  audioStreamIndex: 1,
  hasVideo: true,
  hasAudio: true,
  startTime: 0,
}
const libx264 = proxyEncoders({ hwEncoders: {}, cpuThreads: 8 }).at(-1)!

describe('proxyArgs', () => {
  it('scales to 960 long side with GOP 15, AAC stereo 48 kHz and faststart', () => {
    const args = proxyArgs(baseInfo, 'in.mov', 'out.mp4', libx264)
    const s = args.join(' ')
    expect(s).toContain('-vf scale=540:960:flags=bilinear,format=yuv420p,setsar=1')
    expect(s).toContain('keyint=15:min-keyint=15:scenecut=0:bframes=0')
    expect(s).toContain('-c:a aac -b:a 128k -ar 48000 -ac 2')
    expect(s).toContain('-movflags +faststart')
    expect(s).not.toContain('-hwaccel')
    expect(s).not.toContain('-fps_mode')
    expect(args.at(-1)).toBe('out.mp4')
  })

  it('tone-maps HDR, tags BT.709 and makes VFR constant', () => {
    const s = proxyArgs(
      { ...baseInfo, hdr: 'hlg', vfr: true, fpsRational: '30000/1001' },
      'i',
      'o',
      libx264,
    ).join(' ')
    expect(s).toContain('zscale=tin=arib-std-b67')
    expect(s).toContain('-color_trc bt709')
    expect(s).toContain('-fps_mode cfr -r 30000/1001')
  })

  it('caps high-speed footage at 60 fps and hardware-decodes only big sources', () => {
    const big = { ...baseInfo, width: 2160, height: 3840, fps: 120 }
    const s = proxyArgs(big, 'i', 'o', libx264, 'd3d11va').join(' ')
    expect(s).toContain('-hwaccel d3d11va')
    expect(s).toContain('-fps_mode cfr -r 60')
    expect(proxyArgs(baseInfo, 'i', 'o', libx264, 'd3d11va').join(' ')).not.toContain('-hwaccel')
  })

  it('omits audio mapping for silent video and rejects audio-only input', () => {
    const silent = { ...baseInfo, hasAudio: false } as MediaInfo
    delete silent.audioStreamIndex
    const s = proxyArgs(silent, 'i', 'o', libx264).join(' ')
    expect(s).not.toContain('-c:a')
    expect(s).not.toContain('0:1')
    expect(() =>
      proxyArgs(
        { kind: 'audio', rotation: 0, vfr: false, hasAudio: true, hasVideo: false, startTime: 0 },
        'i',
        'o',
        libx264,
      ),
    ).toThrow(/video stream/)
  })
})

describe('encoders and filters', () => {
  it('prefers the verified GPU encoder and always keeps libx264 as fallback', () => {
    expect(
      proxyEncoders({ hwEncoders: { h264: 'h264_amf' }, cpuThreads: 8 }).map((e) => e.name),
    ).toEqual(['h264_amf', 'libx264'])
    expect(
      proxyEncoders({ hwEncoders: { h264: 'h264_vaapi' }, cpuThreads: 8 }).map((e) => e.name),
    ).toEqual(['libx264'])
    for (const hw of ['h264_amf', 'h264_nvenc', 'h264_qsv', 'h264_videotoolbox']) {
      const [enc] = proxyEncoders({ hwEncoders: { h264: hw }, cpuThreads: 8 })
      expect(enc!.args.join(' ')).toContain('-g 15 -bf 0')
    }
  })

  it('fitEven never upscales and keeps even dimensions', () => {
    expect(fitEven(3840, 2160, 960)).toEqual({ width: 960, height: 540 })
    expect(fitEven(320, 240, 960)).toEqual({ width: 320, height: 240 })
    expect(fitEven(1001, 3001, 960)).toEqual({ width: 320, height: 960 })
    expect(fitEven(1, 1, 960)).toEqual({ width: 2, height: 2 })
  })

  it('tonemapFilter only applies to HDR', () => {
    expect(tonemapFilter({})).toBeUndefined()
    expect(tonemapFilter({ hdr: 'pq', colorRange: 'pc' })).toContain(
      'tin=smpte2084:pin=bt2020:min=bt2020nc:rin=full',
    )
  })

  it('spriteArgs decodes keyframes only when asked to', () => {
    const layout = thumbsLayout(10_000_000, 1080, 1920)
    expect(spriteArgs(baseInfo, 'i', 'o', layout, true)).toContain('nokey')
    const full = spriteArgs(baseInfo, 'i', 'o', layout, false)
    expect(full).not.toContain('nokey')
    expect(full.join(' ')).toContain(`tile=${layout.columns}x${layout.rows}`)
  })
})

describe('PeakAccumulator', () => {
  const pcm = (samples: number[]): Buffer => {
    const b = Buffer.alloc(samples.length * 2)
    samples.forEach((s, i) => b.writeInt16LE(s, i * 2))
    return b
  }

  it('folds samples into int8 min/max buckets with a partial tail', () => {
    const acc = new PeakAccumulator(4, 1)
    acc.push(pcm([0, 32767, -32768, 256, 512, -512, 1000]))
    expect([...acc.finish()]).toEqual([-128, 127, -2, 3])
  })

  it('handles samples straddling chunk boundaries and grows its buffer', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => ((i * 7919) % 65536) - 32768)
    const whole = new PeakAccumulator(3, 1)
    whole.push(pcm(samples))
    const split = new PeakAccumulator(3, 1)
    const bytes = pcm(samples)
    // Odd-sized pieces force a sample to straddle almost every chunk.
    for (let i = 0; i < bytes.length; i += 7) split.push(bytes.subarray(i, i + 7))
    const a = whole.finish()
    expect(a.length).toBe(Math.ceil(1000 / 3) * 2)
    expect([...split.finish()]).toEqual([...a])
  })

  it('returns no peaks for no input', () => {
    expect(new PeakAccumulator().finish().length).toBe(0)
  })
})
