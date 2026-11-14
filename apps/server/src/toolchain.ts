/**
 * Locates FFmpeg/FFprobe/whisper.cpp and VERIFIES hardware encoders with a real test encode.
 *
 * `ffmpeg -encoders` only says an encoder was compiled in — h264_nvenc is listed on machines
 * without NVIDIA GPUs, and AMF fails without a recent driver. So every candidate encodes a few
 * 256×256 frames (in parallel, with a timeout); only passing encoders are used. The result is
 * cached in settings keyed by FFmpeg path + version so later boots are instant.
 */
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DataPaths, Logger, Toolchain } from './contracts.ts'
import { run } from './media/ffmpeg.ts'

export const MIN_FFMPEG_MAJOR = 7

export interface PlatformToolchain extends Toolchain {
  ffmpegMajor: number
  /** Hardware decoders FFmpeg reports (`-hwaccels`); always detected on this platform. */
  hwaccels: string[]
}

export interface EncoderCache {
  ffmpeg: string
  version: string
  hwEncoders: Toolchain['hwEncoders']
  checkedAt: string
}

export interface ToolchainOptions {
  paths: DataPaths
  log: Logger
  ffmpegPath?: string | undefined
  skipEncoderProbe?: boolean
  /** Settings cache for verified encoders (the Store). */
  cache?: { get(): EncoderCache | undefined; set(value: EncoderCache): void }
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

const CACHE_TTL_MS = 30 * 86_400_000
type Codec = 'h264' | 'hevc' | 'av1'
const CODECS: readonly Codec[] = ['h264', 'hevc', 'av1']

/** Hardware encoder families in preference order per platform. */
export const encoderFamilies = (platform: NodeJS.Platform): string[] =>
  platform === 'darwin'
    ? ['videotoolbox']
    : platform === 'win32'
      ? ['nvenc', 'amf', 'qsv']
      : ['nvenc', 'amf', 'qsv', 'vaapi']

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const exe = (name: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? `${name}.exe` : name

/** Searches PATH (honouring PATHEXT on Windows) for an executable. */
export const whichSync = (
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const exts =
    platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs)
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name + ext.toLowerCase())
      if (isFile(candidate)) return candidate
      const upper = path.join(dir, name + ext)
      if (upper !== candidate && isFile(upper)) return upper
    }
  return undefined
}

/** Newest winget-installed Gyan FFmpeg build (Windows). */
const wingetFfmpeg = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const local = env.LOCALAPPDATA
  if (!local) return undefined
  const root = path.join(local, 'Microsoft', 'WinGet', 'Packages')
  let pkgs: string[]
  try {
    pkgs = (await readdir(root)).filter((d) => d.startsWith('Gyan.FFmpeg'))
  } catch {
    return undefined
  }
  const found: string[] = []
  for (const pkg of pkgs) {
    try {
      for (const build of await readdir(path.join(root, pkg))) {
        const bin = path.join(root, pkg, build, 'bin', 'ffmpeg.exe')
        if (isFile(bin)) found.push(bin)
      }
    } catch {
      // unreadable package dir
    }
  }
  // Numeric collation so "ffmpeg-10.0" sorts after "ffmpeg-9.0".
  return found.toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
}

/** Resolves the FFmpeg binary: FFMPEG_PATH → <data>/bin → PATH → winget. */
export const locateFfmpeg = async (opts: {
  ffmpegPath?: string | undefined
  paths: DataPaths
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}): Promise<string | undefined> => {
  const name = exe('ffmpeg', opts.platform)
  if (opts.ffmpegPath) {
    const p = opts.ffmpegPath
    const candidate = existsSync(p) && statSync(p).isDirectory() ? path.join(p, name) : p
    if (isFile(candidate)) return candidate
    throw new Error(`FFMPEG_PATH does not point to an ffmpeg binary: ${p}`)
  }
  for (const c of [
    path.join(opts.paths.bin, 'ffmpeg', 'bin', name),
    path.join(opts.paths.bin, 'ffmpeg', name),
    path.join(opts.paths.bin, name),
  ])
    if (isFile(c)) return c
  return (
    whichSync('ffmpeg', opts.env, opts.platform) ??
    (opts.platform === 'win32' ? await wingetFfmpeg(opts.env) : undefined)
  )
}

/** "ffmpeg version 9.0.2-full_build-www.gyan.dev …" → { version, major }. Git builds → major 99. */
export const parseFfmpegVersion = (text: string): { version: string; major: number } => {
  const m = /ffmpeg version (\S+)/.exec(text)
  if (!m?.[1]) throw new Error('could not parse ffmpeg version')
  const version = m[1]
  const num = /^n?(\d+)\.(\d+)/.exec(version)
  // Nightly builds are versioned "N-12345-g<hash>" (or "git-…"): newer than any release.
  const major = num?.[1] ? Number(num[1]) : /^(N-|git-)/.test(version) ? 99 : 0
  return { version, major }
}

/** Parses `ffmpeg -encoders` into the set of video encoder names. */
export const parseEncoders = (text: string): Set<string> => {
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    // The legend line " V..... = Video" has the same shape; encoder names are identifiers.
    const m = /^\s*V[A-Z.]{5}\s+(\w[\w-]*)\s/.exec(line)
    if (m?.[1]) out.add(m[1])
  }
  return out
}

/** Parses `ffmpeg -hwaccels`. */
export const parseHwaccels = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith(':'))

/** argv for a tiny real encode with `encoder` (256×256 keeps every HW encoder's minimums happy). */
export const testEncodeArgs = (encoder: string): string[] => {
  const vaapi = encoder.endsWith('_vaapi')
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    ...(vaapi ? ['-vaapi_device', '/dev/dri/renderD128'] : []),
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=256x256:r=30',
    '-frames:v',
    '5',
    ...(vaapi ? ['-vf', 'format=nv12,hwupload'] : ['-pix_fmt', 'yuv420p']),
    '-c:v',
    encoder,
    '-f',
    'null',
    '-',
  ]
}

/** Test-encodes every compiled-in HW encoder candidate in parallel; returns the best per codec. */
export const verifyEncoders = async (
  ffmpeg: string,
  available: Set<string>,
  platform: NodeJS.Platform,
  log?: Logger,
  timeoutMs = 15_000,
): Promise<Toolchain['hwEncoders']> => {
  const families = encoderFamilies(platform)
  const candidates = CODECS.flatMap((codec) =>
    families.map((f) => `${codec}_${f}`).filter((e) => available.has(e)),
  )
  const results = await Promise.all(
    candidates.map(async (encoder) => {
      const t0 = performance.now()
      try {
        await run(ffmpeg, testEncodeArgs(encoder), { timeoutMs })
        log?.debug({ encoder, ms: Math.round(performance.now() - t0) }, 'encoder verified')
        return encoder
      } catch (err) {
        log?.debug({ encoder, err: (err as Error).message }, 'encoder unavailable')
        return undefined
      }
    }),
  )
  const ok = new Set(results.filter((e): e is string => e !== undefined))
  const out: Toolchain['hwEncoders'] = {}
  for (const codec of CODECS) {
    const best = families.map((f) => `${codec}_${f}`).find((e) => ok.has(e))
    if (best) out[codec] = best
  }
  return out
}

const listModels = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir))
      .filter((f) => /^ggml-.+\.bin$/.test(f))
      .sort()
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

/** Detects the whole toolchain. Throws when FFmpeg is missing or too old. */
export const detectToolchain = async (opts: ToolchainOptions): Promise<PlatformToolchain> => {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const ffmpeg = await locateFfmpeg({
    ffmpegPath: opts.ffmpegPath,
    paths: opts.paths,
    env,
    platform,
  })
  if (!ffmpeg)
    throw new Error(
      'FFmpeg not found. Install FFmpeg 7+ (Windows: `winget install Gyan.FFmpeg`) or set FFMPEG_PATH.',
    )
  const probeName = exe('ffprobe', platform)
  const sibling = path.join(path.dirname(ffmpeg), probeName)
  const ffprobe = isFile(sibling) ? sibling : whichSync('ffprobe', env, platform)
  if (!ffprobe) throw new Error(`ffprobe not found next to ${ffmpeg} or on PATH`)

  const [versionOut, encodersOut, hwaccelsOut] = await Promise.all(
    [
      ['-hide_banner', '-version'],
      ['-hide_banner', '-encoders'],
      ['-hide_banner', '-hwaccels'],
    ].map(async (args) =>
      (await run(ffmpeg, args, { captureStdout: true, timeoutMs: 15_000 })).stdout.toString(),
    ),
  )
  const { version, major } = parseFfmpegVersion(versionOut!)
  if (major < MIN_FFMPEG_MAJOR)
    throw new Error(
      `FFmpeg ${version} is too old; ReelForge needs FFmpeg ${MIN_FFMPEG_MAJOR}+ (${ffmpeg})`,
    )
  const hwaccels = parseHwaccels(hwaccelsOut!)

  let hwEncoders: Toolchain['hwEncoders'] = {}
  if (!opts.skipEncoderProbe) {
    const cached = opts.cache?.get()
    if (
      cached &&
      cached.ffmpeg === ffmpeg &&
      cached.version === version &&
      Date.now() - Date.parse(cached.checkedAt) < CACHE_TTL_MS
    ) {
      hwEncoders = cached.hwEncoders
    } else {
      const t0 = performance.now()
      hwEncoders = await verifyEncoders(ffmpeg, parseEncoders(encodersOut!), platform, opts.log)
      opts.log.info(
        { hwEncoders, ms: Math.round(performance.now() - t0) },
        'verified hardware encoders',
      )
      opts.cache?.set({ ffmpeg, version, hwEncoders, checkedAt: new Date().toISOString() })
    }
  }

  const whisperBin = path.join(opts.paths.bin, 'whisper', exe('whisper-cli', platform))
  const tools: PlatformToolchain = {
    ffmpeg,
    ffprobe,
    ffmpegVersion: version,
    ffmpegMajor: major,
    hwEncoders,
    hwaccels,
    whisperModels: await listModels(path.join(opts.paths.models, 'whisper')),
    cpuThreads: os.availableParallelism(),
  }
  if (isFile(whisperBin)) tools.whisper = whisperBin
  const hwDecode =
    platform === 'win32' && hwaccels.includes('d3d11va')
      ? 'd3d11va'
      : platform === 'darwin' && hwaccels.includes('videotoolbox')
        ? 'videotoolbox'
        : undefined
  if (hwDecode) tools.hwDecode = hwDecode
  return tools
}
