/**
 * Toolchain detection: version/encoder parsing, binary location order, parallel encoder
 * verification and the per-version encoder cache. Process spawning is faked through a seam on
 * `run` so the logic is deterministic on any machine; one test exercises the real FFmpeg.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions, RunResult } from '../src/media/ffmpeg.ts'
import {
  detectToolchain,
  encoderFamilies,
  type EncoderCache,
  locateFfmpeg,
  MIN_FFMPEG_MAJOR,
  parseEncoders,
  parseFfmpegVersion,
  parseHwaccels,
  testEncodeArgs,
  verifyEncoders,
  whichSync,
} from '../src/toolchain.ts'
import { log, realToolchain, tempData, tempDir } from './helpers.ts'

type FakeRun = (bin: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>
const fake = vi.hoisted(() => ({ run: undefined as FakeRun | undefined }))

vi.mock('../src/media/ffmpeg.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/media/ffmpeg.ts')>()
  return {
    ...real,
    run: (bin: string, args: readonly string[], opts?: RunOptions) =>
      fake.run ? fake.run(bin, args, opts) : real.run(bin, args, opts),
  }
})

afterEach(() => {
  fake.run = undefined
})

const ok = (stdout = ''): RunResult => ({ stdout: Buffer.from(stdout), stderr: '' })

const ENCODERS_OUT = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC
 V....D h264_amf             AMD AMF H.264 Encoder
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder
 V....D h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration)
 V....D hevc_amf             AMD AMF HEVC encoder
 V....D av1_amf              AMD AMF AV1 encoder
 A....D aac                  AAC (Advanced Audio Coding)
`

describe('parsers', () => {
  it('parses release, n-prefixed and nightly FFmpeg versions', () => {
    expect(parseFfmpegVersion('ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright')).toEqual({
      version: '9.0.2-full_build-www.gyan.dev',
      major: 9,
    })
    expect(parseFfmpegVersion('ffmpeg version n7.1 Copyright').major).toBe(7)
    expect(parseFfmpegVersion('ffmpeg version N-118000-gabcdef Copyright').major).toBe(99)
    expect(parseFfmpegVersion('ffmpeg version 2026-01-01-git-abc Copyright').major).toBe(0)
    expect(() => parseFfmpegVersion('not ffmpeg')).toThrow(/could not parse/)
  })

  it('extracts only video encoders and hwaccels', () => {
    expect([...parseEncoders(ENCODERS_OUT)]).toEqual([
      'libx264',
      'h264_amf',
      'h264_nvenc',
      'h264_qsv',
      'hevc_amf',
      'av1_amf',
    ])
    expect(parseHwaccels('Hardware acceleration methods:\ncuda\nd3d11va\r\n\nqsv\n')).toEqual([
      'cuda',
      'd3d11va',
      'qsv',
    ])
  })

  it('orders encoder families per platform', () => {
    expect(encoderFamilies('darwin')).toEqual(['videotoolbox'])
    expect(encoderFamilies('win32')).toEqual(['nvenc', 'amf', 'qsv'])
    expect(encoderFamilies('linux')).toContain('vaapi')
  })

  it('test encodes use 256×256 frames and upload to VAAPI surfaces when needed', () => {
    const amf = testEncodeArgs('h264_amf')
    expect(amf).toContain('color=c=black:s=256x256:r=30')
    expect(amf.slice(amf.indexOf('-c:v'), amf.indexOf('-c:v') + 2)).toEqual(['-c:v', 'h264_amf'])
    expect(amf).not.toContain('-vaapi_device')
    const vaapi = testEncodeArgs('hevc_vaapi')
    expect(vaapi).toContain('-vaapi_device')
    expect(vaapi).toContain('format=nv12,hwupload')
  })
})

describe('binary location', () => {
  it('whichSync searches PATH with PATHEXT on Windows and plain names elsewhere', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      await mkdir(path.join(dir, 'a'))
      await mkdir(path.join(dir, 'b'))
      await writeFile(path.join(dir, 'b', 'tool.exe'), '')
      await writeFile(path.join(dir, 'b', 'tool'), '')
      const PATH = [path.join(dir, 'a'), path.join(dir, 'b')].join(path.delimiter)
      expect(whichSync('tool', { PATH, PATHEXT: '.COM;.EXE' }, 'win32')).toBe(
        path.join(dir, 'b', 'tool.exe'),
      )
      expect(whichSync('tool', { PATH }, 'linux')).toBe(path.join(dir, 'b', 'tool'))
      expect(whichSync('missing', { PATH }, 'linux')).toBeUndefined()
      expect(whichSync('tool', {}, 'linux')).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('locates FFmpeg via FFMPEG_PATH (file or dir) → <data>/bin → PATH', async () => {
    const { paths, cleanup } = await tempData()
    try {
      const env = { PATH: '' }
      const platform = 'linux' as const
      expect(await locateFfmpeg({ paths, env, platform })).toBeUndefined()

      const onPath = path.join(paths.root, 'path-bin')
      await mkdir(onPath)
      await writeFile(path.join(onPath, 'ffmpeg'), '')
      expect(await locateFfmpeg({ paths, env: { PATH: onPath }, platform })).toBe(
        path.join(onPath, 'ffmpeg'),
      )

      // A copy in <data>/bin/ffmpeg/bin wins over PATH.
      const bundled = path.join(paths.bin, 'ffmpeg', 'bin')
      await mkdir(bundled, { recursive: true })
      await writeFile(path.join(bundled, 'ffmpeg'), '')
      expect(await locateFfmpeg({ paths, env: { PATH: onPath }, platform })).toBe(
        path.join(bundled, 'ffmpeg'),
      )

      // FFMPEG_PATH wins over everything; a directory is accepted.
      expect(await locateFfmpeg({ paths, env, platform, ffmpegPath: onPath })).toBe(
        path.join(onPath, 'ffmpeg'),
      )
      await expect(
        locateFfmpeg({ paths, env, platform, ffmpegPath: path.join(paths.root, 'nope') }),
      ).rejects.toThrow(/FFMPEG_PATH/)
    } finally {
      await cleanup()
    }
  })

  it('finds the newest winget Gyan build on Windows (numeric version order)', async () => {
    const { paths, cleanup } = await tempData()
    try {
      const pkgs = path.join(paths.root, 'local', 'Microsoft', 'WinGet', 'Packages')
      for (const build of [
        'ffmpeg-9.0.2-full_build',
        'ffmpeg-10.0-full_build',
        'ffmpeg-8.0-full_build',
      ]) {
        const bin = path.join(pkgs, 'Gyan.FFmpeg_Microsoft.Winget.Source_x', build, 'bin')
        await mkdir(bin, { recursive: true })
        await writeFile(path.join(bin, 'ffmpeg.exe'), '')
      }
      const found = await locateFfmpeg({
        paths,
        env: { PATH: '', LOCALAPPDATA: path.join(paths.root, 'local') },
        platform: 'win32',
      })
      expect(found).toContain('ffmpeg-10.0-full_build')
    } finally {
      await cleanup()
    }
  })
})

describe('encoder verification', () => {
  it('test-encodes every candidate in parallel and keeps the best passing one per codec', async () => {
    let inFlight = 0
    let peak = 0
    const tried: string[] = []
    fake.run = async (_bin, args) => {
      const encoder = args[args.indexOf('-c:v') + 1]!
      tried.push(encoder)
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      // NVENC is compiled in but there is no NVIDIA GPU; AMF works for H.264/HEVC only.
      if (encoder.endsWith('_nvenc') || encoder === 'av1_amf') throw new Error('no device')
      return ok()
    }
    const result = await verifyEncoders('ffmpeg', parseEncoders(ENCODERS_OUT), 'win32')
    expect(result).toEqual({ h264: 'h264_amf', hevc: 'hevc_amf' })
    expect(tried.toSorted()).toEqual(['av1_amf', 'h264_amf', 'h264_nvenc', 'h264_qsv', 'hevc_amf'])
    expect(peak).toBe(tried.length)
  })

  const detectWith = async (
    cache: { value?: EncoderCache },
    versionLine: string,
  ): Promise<{ tools: Awaited<ReturnType<typeof detectToolchain>>; probes: number }> => {
    const { paths, cleanup } = await tempData()
    let probes = 0
    try {
      const bin = path.join(paths.bin, 'ffmpeg')
      await writeFile(path.join(paths.bin, 'ffmpeg'), '')
      await writeFile(path.join(paths.bin, 'ffprobe'), '')
      await mkdir(path.join(paths.models, 'whisper'), { recursive: true })
      await writeFile(path.join(paths.models, 'whisper', 'ggml-base.en.bin'), '')
      await writeFile(path.join(paths.models, 'whisper', 'notes.txt'), '')
      fake.run = async (_bin, args) => {
        if (args.includes('-version')) return ok(versionLine)
        if (args.includes('-encoders')) return ok(ENCODERS_OUT)
        if (args.includes('-hwaccels')) return ok('Hardware acceleration methods:\nd3d11va\n')
        probes++
        return ok()
      }
      const tools = await detectToolchain({
        paths,
        log,
        env: { PATH: '' },
        platform: 'linux',
        cache: {
          get: () => cache.value,
          set: (v) => {
            cache.value = v
          },
        },
      })
      expect(tools.ffmpeg).toBe(bin)
      expect(tools.ffprobe).toBe(path.join(paths.bin, 'ffprobe'))
      expect(tools.whisperModels).toEqual([path.join(paths.models, 'whisper', 'ggml-base.en.bin')])
      expect(tools.whisper).toBeUndefined()
      return { tools, probes }
    } finally {
      await cleanup()
    }
  }

  it('caches verified encoders keyed by FFmpeg path + version', async () => {
    const cache: { value?: EncoderCache } = {}
    const first = await detectWith(cache, 'ffmpeg version 9.0.2 Copyright')
    expect(first.probes).toBeGreaterThan(0)
    expect(first.tools.hwEncoders.h264).toBeDefined()
    expect(first.tools.ffmpegMajor).toBe(9)
    expect(cache.value?.version).toBe('9.0.2')

    // A cache entry for the same binary + version is used as-is: no test encodes at all.
    const hit: { value?: EncoderCache } = {
      value: { ...cache.value!, hwEncoders: { h264: 'cached_h264' } },
    }
    const { paths, cleanup } = await tempData()
    try {
      await writeFile(path.join(paths.bin, 'ffmpeg'), '')
      await writeFile(path.join(paths.bin, 'ffprobe'), '')
      hit.value!.ffmpeg = path.join(paths.bin, 'ffmpeg')
      let probes = 0
      fake.run = async (_bin, args) => {
        if (args.includes('-version')) return ok('ffmpeg version 9.0.2 Copyright')
        if (args.includes('-encoders')) return ok(ENCODERS_OUT)
        if (args.includes('-hwaccels')) return ok('')
        probes++
        return ok()
      }
      const opts = {
        paths,
        log,
        env: { PATH: '' },
        platform: 'linux' as const,
        cache: { get: () => hit.value, set: (v: EncoderCache) => void (hit.value = v) },
      }
      expect((await detectToolchain(opts)).hwEncoders).toEqual({ h264: 'cached_h264' })
      expect(probes).toBe(0)

      // A new FFmpeg version invalidates the cache.
      fake.run = async (_bin, args) => {
        if (args.includes('-version')) return ok('ffmpeg version 9.1 Copyright')
        if (args.includes('-encoders')) return ok(ENCODERS_OUT)
        if (args.includes('-hwaccels')) return ok('')
        probes++
        return ok()
      }
      const upgraded = await detectToolchain(opts)
      expect(probes).toBeGreaterThan(0)
      expect(upgraded.hwEncoders.h264).not.toBe('cached_h264')
      expect(hit.value?.version).toBe('9.1')
    } finally {
      await cleanup()
    }
  })

  it(`rejects FFmpeg older than ${MIN_FFMPEG_MAJOR}`, async () => {
    await expect(detectWith({}, 'ffmpeg version 6.1.1 Copyright')).rejects.toThrow(/too old/)
  })

  it('reports a missing FFmpeg with install guidance', async () => {
    const { paths, cleanup } = await tempData()
    try {
      await expect(
        detectToolchain({ paths, log, env: { PATH: '' }, platform: 'linux' }),
      ).rejects.toThrow(/FFmpeg not found/)
    } finally {
      await cleanup()
    }
  })
})

const real = await realToolchain()
describe.skipIf(!real)('real FFmpeg', () => {
  if (!real) console.warn('[toolchain] FFmpeg not found — skipping real toolchain checks')

  it('detects version ≥ 7, ffprobe and CPU threads; HW verification finishes quickly', async () => {
    const tools = real!
    expect(tools.ffmpegMajor).toBeGreaterThanOrEqual(MIN_FFMPEG_MAJOR)
    expect(path.basename(tools.ffprobe)).toMatch(/^ffprobe(\.exe)?$/)
    expect(tools.cpuThreads).toBeGreaterThan(0)

    const { stdout } = await (
      await import('../src/media/ffmpeg.ts')
    ).run(tools.ffmpeg, ['-hide_banner', '-encoders'], { captureStdout: true })
    const t0 = performance.now()
    const hw = await verifyEncoders(
      tools.ffmpeg,
      parseEncoders(stdout.toString()),
      process.platform,
    )
    const ms = Math.round(performance.now() - t0)
    console.warn(`[toolchain] verified HW encoders on this host in ${ms} ms:`, hw)
    for (const [codec, encoder] of Object.entries(hw)) expect(encoder).toMatch(`${codec}_`)
  })
})
