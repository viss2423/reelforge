import { describe, expect, it } from 'vitest'
import {
  cpuEncoder,
  hardwareEncoder,
  pickEncoder,
  videoBitrate,
  type EncodeTarget,
} from '../../src/render/encoders.ts'

const T: EncodeTarget = { width: 1080, height: 1920, fps: 30, quality: 'high', codec: 'h264' }

const after = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('videoBitrate', () => {
  it('follows the documented table at 1080×1920 @ 30', () => {
    expect(videoBitrate({ ...T, quality: 'draft' })).toBe(6_000_000)
    expect(videoBitrate({ ...T, quality: 'standard' })).toBe(10_000_000)
    expect(videoBitrate(T)).toBe(16_000_000)
    expect(videoBitrate({ ...T, quality: 'max' })).toBe(24_000_000)
  })

  it('scales with resolution, frame rate and codec efficiency', () => {
    const r720 = videoBitrate({ ...T, width: 720, height: 1280 })
    const r4k = videoBitrate({ ...T, width: 2160, height: 3840 })
    expect(r720).toBeLessThan(16_000_000)
    expect(r4k).toBeGreaterThan(40_000_000)
    expect(r4k).toBeLessThan(64_000_000) // sub-linear in pixels
    expect(videoBitrate({ ...T, fps: 60 })).toBeGreaterThan(16_000_000)
    expect(videoBitrate({ ...T, fps: 60 })).toBeLessThan(32_000_000)
    expect(videoBitrate({ ...T, codec: 'hevc' })).toBe(10_400_000)
    expect(videoBitrate({ ...T, codec: 'av1' })).toBe(8_000_000)
  })
})

describe('cpuEncoder', () => {
  it('libx264: High profile, capped CRF, closed 2 s GOP', () => {
    const e = cpuEncoder(T)
    expect(e).toMatchObject({ video: 'libx264', pixFmt: 'yuv420p', hardware: false })
    expect(after(e.args, '-preset')).toBe('medium')
    expect(after(e.args, '-crf')).toBe('19')
    expect(after(e.args, '-profile:v')).toBe('high')
    expect(after(e.args, '-g')).toBe('60')
    expect(after(e.args, '-flags')).toBe('+cgop')
    expect(after(e.args, '-maxrate')).toBe('24000k')
    expect(after(e.args, '-bufsize')).toBe('32000k')
  })

  it('maps quality to presets and uses ultrafast for previews', () => {
    expect(after(cpuEncoder({ ...T, quality: 'draft' }).args, '-preset')).toBe('veryfast')
    expect(after(cpuEncoder({ ...T, quality: 'max' }).args, '-preset')).toBe('slow')
    expect(after(cpuEncoder({ ...T, preview: true }).args, '-preset')).toBe('ultrafast')
    expect(after(cpuEncoder({ ...T, fps: 60 }).args, '-g')).toBe('120')
  })

  it('libx265 is tagged hvc1 with a closed GOP; AV1 uses SVT-AV1', () => {
    const h = cpuEncoder({ ...T, codec: 'hevc' })
    expect(h.video).toBe('libx265')
    expect(after(h.args, '-tag:v')).toBe('hvc1')
    expect(after(h.args, '-x265-params')).toMatch(
      /keyint=60:min-keyint=30:open-gop=0:vbv-maxrate=15600/,
    )
    const a = cpuEncoder({ ...T, codec: 'av1' })
    expect(a).toMatchObject({ video: 'libsvtav1', pixFmt: 'yuv420p' })
    expect(after(a.args, '-preset')).toBe('6')
  })
})

describe('hardware encoders', () => {
  it('AMF: transcoding usage, quality preset, peak-constrained VBR, B-frames, pre-analysis, nv12', () => {
    const e = hardwareEncoder('h264_amf', T)!
    expect(e).toMatchObject({ video: 'h264_amf', pixFmt: 'nv12', hardware: true })
    expect(after(e.args, '-usage')).toBe('transcoding')
    expect(after(e.args, '-quality')).toBe('quality')
    expect(after(e.args, '-rc')).toBe('vbr_peak')
    expect(after(e.args, '-b:v')).toBe('16000k')
    expect(after(e.args, '-maxrate')).toBe('24000k')
    expect(after(e.args, '-profile:v')).toBe('high')
    expect(after(e.args, '-g')).toBe('60')
    expect(after(e.args, '-bf')).toBe('3')
    expect(after(e.args, '-preanalysis')).toBe('1')
  })

  it('AMF presets per quality; HEVC AMF has no high_quality or B-frames; previews use speed', () => {
    expect(after(hardwareEncoder('h264_amf', { ...T, quality: 'max' })!.args, '-quality')).toBe(
      'high_quality',
    )
    const hevc = hardwareEncoder('hevc_amf', { ...T, codec: 'hevc', quality: 'max' })!
    expect(after(hevc.args, '-quality')).toBe('quality')
    expect(hevc.args).not.toContain('-bf')
    expect(after(hevc.args, '-tag:v')).toBe('hvc1')
    const prev = hardwareEncoder('h264_amf', { ...T, preview: true })!
    expect(after(prev.args, '-quality')).toBe('speed')
    expect(prev.args).not.toContain('-preanalysis')
    expect(after(hardwareEncoder('h264_amf', { ...T, quality: 'draft' })!.args, '-quality')).toBe(
      'speed',
    )
  })

  it('NVENC / QSV / VideoToolbox equivalents', () => {
    const nv = hardwareEncoder('h264_nvenc', T)!
    expect(after(nv.args, '-preset')).toBe('p5')
    expect(after(nv.args, '-rc')).toBe('vbr')
    const qsv = hardwareEncoder('hevc_qsv', { ...T, codec: 'hevc' })!
    expect(after(qsv.args, '-preset')).toBe('slow')
    expect(after(qsv.args, '-profile:v')).toBe('main')
    const vt = hardwareEncoder('h264_videotoolbox', T)!
    expect(vt).toMatchObject({ pixFmt: 'nv12', hardware: true })
    expect(hardwareEncoder('h264_v4l2m2m', T)).toBeUndefined()
  })
})

describe('pickEncoder', () => {
  const hw = { h264: 'h264_amf', hevc: 'hevc_amf' }

  it('prefers the verified GPU encoder for auto and gpu', () => {
    expect(pickEncoder('auto', hw, T).video).toBe('h264_amf')
    expect(pickEncoder('gpu', hw, { ...T, codec: 'hevc' }).video).toBe('hevc_amf')
  })

  it('uses the CPU when asked or when no GPU encoder exists for the codec', () => {
    expect(pickEncoder('cpu', hw, T).video).toBe('libx264')
    expect(pickEncoder('auto', hw, { ...T, codec: 'av1' }).video).toBe('libsvtav1')
    expect(pickEncoder('gpu', {}, T).video).toBe('libx264')
    expect(pickEncoder('auto', { h264: 'h264_unknownhw' }, T).video).toBe('libx264')
  })
})
