/** Host prerequisite checks (Node, FFmpeg) with actionable guidance. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface CheckResult {
  name: string
  ok: boolean
  /** Hard requirement? Optional checks only warn. */
  required: boolean
  detail: string
  fix?: string
}

export const MIN_NODE_MAJOR = 26
export const MIN_FFMPEG_MAJOR = 7

export const checkNode = (version = process.versions.node): CheckResult => {
  const major = Number(version.split('.')[0])
  const ok = major >= MIN_NODE_MAJOR
  return {
    name: 'Node.js',
    ok,
    required: true,
    detail: `v${version}`,
    ...(ok
      ? {}
      : {
          fix:
            process.platform === 'win32'
              ? 'winget install OpenJS.NodeJS.LTS   (or https://nodejs.org)'
              : `Install Node ${MIN_NODE_MAJOR}+ (https://nodejs.org or your package manager / nvm)`,
        }),
  }
}

/** Filters the render + AI pipelines rely on. */
export const REQUIRED_FILTERS = [
  'ass',
  'xfade',
  'lut3d',
  'zscale',
  'tonemap',
  'rubberband',
  'arnndn',
  'loudnorm',
  'ebur128',
  'silencedetect',
  'scdet',
  'sidechaincompress',
] as const
/** Nice-to-have filters (faster/better paths when present). */
export const OPTIONAL_FILTERS = ['libplacebo', 'whisper'] as const
export const REQUIRED_ENCODERS = ['libx264', 'aac'] as const
export const GPU_ENCODERS = [
  'h264_amf',
  'hevc_amf',
  'av1_amf',
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'h264_videotoolbox',
  'h264_vaapi',
] as const

/** Parse `ffmpeg -version` first line → major version (git builds report 0 → treated as new). */
export const parseFfmpegVersion = (text: string): { version: string; major: number } => {
  const m = /ffmpeg version (\S+)/.exec(text)
  const version = m?.[1] ?? 'unknown'
  const num = /^n?(\d+)\./.exec(version)
  // Nightly builds look like "N-120000-g…" or "2026-10-01-git-…": newer than any release.
  const major = num ? Number(num[1]) : /^(N-|\d{4}-\d{2}-\d{2})/.test(version) ? 99 : 0
  return { version, major }
}

/** Names from `ffmpeg -filters` / `-encoders` listings (second column). */
export const parseCapabilityList = (text: string): Set<string> => {
  const out = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[A-Z.|]{2,8}\s+(\S+)\s/.exec(line)
    if (m?.[1]) out.add(m[1])
  }
  return out
}

const ffmpegFix = (): string =>
  process.platform === 'win32'
    ? 'winget install Gyan.FFmpeg   (full build: libass, rubberband, zimg, libplacebo, whisper)'
    : process.platform === 'darwin'
      ? 'brew install ffmpeg'
      : 'Install a recent static build from https://johnvansickle.com/ffmpeg/ or your distro (FFmpeg ≥ 7 with libass, librubberband, libzimg)'

/** Check FFmpeg presence, version, filters and encoders. */
export const checkFfmpeg = async (
  ffmpeg = process.env.REELFORGE_FFMPEG ?? 'ffmpeg',
): Promise<CheckResult[]> => {
  let versionText: string
  try {
    versionText = (await run(ffmpeg, ['-hide_banner', '-version'], { windowsHide: true })).stdout
  } catch {
    return [
      { name: 'FFmpeg', ok: false, required: true, detail: 'not found on PATH', fix: ffmpegFix() },
    ]
  }
  const { version, major } = parseFfmpegVersion(versionText)
  const results: CheckResult[] = [
    {
      name: 'FFmpeg',
      ok: major >= MIN_FFMPEG_MAJOR,
      required: true,
      detail: version,
      ...(major >= MIN_FFMPEG_MAJOR ? {} : { fix: ffmpegFix() }),
    },
  ]
  const [filtersOut, encodersOut] = await Promise.all([
    run(ffmpeg, ['-hide_banner', '-filters'], { windowsHide: true, maxBuffer: 8 << 20 }),
    run(ffmpeg, ['-hide_banner', '-encoders'], { windowsHide: true, maxBuffer: 8 << 20 }),
  ])
  const filters = parseCapabilityList(filtersOut.stdout)
  const encoders = parseCapabilityList(encodersOut.stdout)
  const missing = REQUIRED_FILTERS.filter((f) => !filters.has(f))
  const missingEnc = REQUIRED_ENCODERS.filter((e) => !encoders.has(e))
  results.push({
    name: 'FFmpeg filters',
    ok: missing.length === 0,
    required: true,
    detail: missing.length
      ? `missing: ${missing.join(', ')}`
      : `${REQUIRED_FILTERS.length} required present`,
    ...(missing.length ? { fix: ffmpegFix() } : {}),
  })
  const optionalMissing = OPTIONAL_FILTERS.filter((f) => !filters.has(f))
  results.push({
    name: 'FFmpeg optional filters',
    ok: optionalMissing.length === 0,
    required: false,
    detail: optionalMissing.length
      ? `missing: ${optionalMissing.join(', ')}`
      : OPTIONAL_FILTERS.join(', '),
  })
  results.push({
    name: 'FFmpeg encoders',
    ok: missingEnc.length === 0,
    required: true,
    detail: missingEnc.length ? `missing: ${missingEnc.join(', ')}` : REQUIRED_ENCODERS.join(', '),
    ...(missingEnc.length ? { fix: ffmpegFix() } : {}),
  })
  const gpu = GPU_ENCODERS.filter((e) => encoders.has(e))
  results.push({
    name: 'GPU encoders (compiled in)',
    ok: gpu.length > 0,
    required: false,
    detail: gpu.length
      ? `${gpu.join(', ')} (verified by the server at startup)`
      : 'none — CPU encoding only',
  })
  return results
}
