/**
 * Shared FFmpeg filter/encoder fragments for derived media (proxies, thumbnails, posters).
 */
import type { Toolchain } from '../contracts.ts'
import type { MediaInfo } from './probe.ts'

/** Fits (w,h) into `maxLong` on the long side, keeping aspect, both dimensions even. */
export const fitEven = (
  width: number,
  height: number,
  maxLong: number,
): { width: number; height: number } => {
  const scale = Math.min(1, maxLong / Math.max(width, height))
  const even = (n: number): number => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { width: even(width), height: even(height) }
}

/**
 * HDR (HLG/PQ, usually 10-bit BT.2020 from phones) → SDR BT.709 tone mapping with zscale.
 * Applied AFTER downscaling so the expensive float conversion runs on few pixels.
 * Returns undefined for SDR sources.
 */
export const tonemapFilter = (
  info: Pick<MediaInfo, 'hdr' | 'colorTransfer' | 'colorPrimaries' | 'colorSpace' | 'colorRange'>,
): string | undefined => {
  if (!info.hdr) return undefined
  const tin = info.hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084'
  const pin =
    info.colorPrimaries === 'bt2020' || !info.colorPrimaries ? 'bt2020' : info.colorPrimaries
  const min = info.colorSpace === 'bt2020c' ? 'bt2020c' : 'bt2020nc'
  const rin = info.colorRange === 'pc' ? 'full' : 'limited'
  return [
    `zscale=tin=${tin}:pin=${pin}:min=${min}:rin=${rin}:t=linear:npl=100`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=limited',
  ].join(',')
}

/** Output colour tags for SDR BT.709 (written when the source was HDR so players don't guess). */
export const BT709_TAGS: readonly string[] = [
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709',
]

export interface VideoEncoder {
  name: string
  args: string[]
}

/**
 * Proxy encoders in preference order: the GPU H.264 encoder that passed the startup test
 * encode, then libx264. Proxies are optimised for scrubbing: GOP 15, no B-frames.
 */
export const proxyEncoders = (
  tools: Pick<Toolchain, 'hwEncoders' | 'cpuThreads'>,
): VideoEncoder[] => {
  const gop = ['-g', '15', '-bf', '0']
  const out: VideoEncoder[] = []
  const hw = tools.hwEncoders.h264
  if (hw === 'h264_amf')
    out.push({
      name: hw,
      args: [
        '-c:v',
        hw,
        '-usage',
        'transcoding',
        '-quality',
        'speed',
        '-rc',
        'cqp',
        '-qp_i',
        '24',
        '-qp_p',
        '26',
        ...gop,
      ],
    })
  else if (hw === 'h264_nvenc')
    out.push({
      name: hw,
      args: ['-c:v', hw, '-preset', 'p2', '-rc', 'constqp', '-qp', '26', ...gop],
    })
  else if (hw === 'h264_qsv')
    out.push({
      name: hw,
      args: ['-c:v', hw, '-preset', 'veryfast', '-global_quality', '26', ...gop],
    })
  else if (hw === 'h264_videotoolbox')
    out.push({ name: hw, args: ['-c:v', hw, '-q:v', '55', '-realtime', '1', ...gop] })
  // VAAPI needs hwupload in the graph; proxies use libx264 there.
  out.push({
    name: 'libx264',
    args: [
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-profile:v',
      'high',
      '-x264-params',
      'keyint=15:min-keyint=15:scenecut=0:bframes=0',
    ],
  })
  return out
}
