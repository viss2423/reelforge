/**
 * Bootstrap (`scripts/setup.mjs` + `scripts/lib`) tests: resumable verified downloads against
 * a local HTTP server, release/build selection, prerequisite parsing, terminal rendering and
 * an end-to-end idempotent run of the real script against the data dir.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  checkNode,
  parseCapabilityList,
  parseFfmpegVersion,
} from '../../../../scripts/lib/checks.ts'
import { ChecksumError, download, verifyExisting } from '../../../../scripts/lib/download.ts'
import {
  formatBytes,
  formatDuration,
  formatTable,
  renderBar,
} from '../../../../scripts/lib/progress.ts'
import {
  buildCandidates,
  nightlyTagFromBody,
  resolveBinary,
  type GhRelease,
  type HostInfo,
} from '../../../../scripts/lib/whisper.ts'
import { DATA_DIR, makeTempDir, NO_FFMPEG, skipBecause } from './helpers.ts'

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

describe('download', () => {
  const body = Buffer.alloc(300_000)
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + (i >> 8)) & 0xff
  const digest = sha(body)
  let server: Server
  let base = ''
  let requests: IncomingMessage[] = []
  /** Per-test server behaviour. */
  let mode: 'ranges' | 'no-ranges' | 'corrupt' | 'missing' = 'ranges'
  const tmp = makeTempDir('download')

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req)
      if (mode === 'missing') {
        res.writeHead(404).end()
        return
      }
      const payload = mode === 'corrupt' ? Buffer.from(body).fill(1, 0, 10) : body
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
      if (range && mode !== 'no-ranges') {
        const start = Number(range[1])
        res.writeHead(206, {
          'content-length': payload.length - start,
          'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
        })
        res.end(payload.subarray(start))
        return
      }
      res.writeHead(200, { 'content-length': payload.length })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    tmp.cleanup()
  })
  beforeEach(() => {
    requests = []
    mode = 'ranges'
  })

  const dest = (name: string): string => path.join(tmp.dir, name)

  it('downloads, verifies and stamps; a re-run is served from the stamp without network', async () => {
    const file = dest('a.bin')
    const r = await download({
      url: `${base}/a`,
      dest: file,
      sha256: digest,
      size: body.length,
      quiet: true,
    })
    expect(r).toMatchObject({ status: 'downloaded', sha256: digest, size: body.length })
    expect(sha(readFileSync(file))).toBe(digest)
    expect(readFileSync(`${file}.sha256`, 'utf8')).toMatch(new RegExp(`^${digest} ${body.length} `))
    const again = await download({ url: `${base}/a`, dest: file, sha256: digest, quiet: true })
    expect(again.status).toBe('cached')
    expect(requests).toHaveLength(1)
  })

  it('resumes a partial download with a Range request and hashes the whole file', async () => {
    const file = dest('b.bin')
    writeFileSync(`${file}.part`, body.subarray(0, 123_456))
    const r = await download({ url: `${base}/b`, dest: file, sha256: digest, quiet: true })
    expect(r.status).toBe('resumed')
    expect(requests[0]?.headers.range).toBe('bytes=123456-')
    expect(sha(readFileSync(file))).toBe(digest)
    expect(existsSync(`${file}.part`)).toBe(false)
  })

  it('starts over when the server ignores ranges', async () => {
    mode = 'no-ranges'
    const file = dest('c.bin')
    writeFileSync(`${file}.part`, body.subarray(0, 1000))
    const r = await download({ url: `${base}/c`, dest: file, sha256: digest, quiet: true })
    expect(r.status).toBe('downloaded')
    expect(sha(readFileSync(file))).toBe(digest)
  })

  it('rejects corrupt data with a ChecksumError and never keeps the bad bytes', async () => {
    mode = 'corrupt'
    const file = dest('d.bin')
    const err = await download({
      url: `${base}/d`,
      dest: file,
      sha256: digest,
      retries: 1,
      quiet: true,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChecksumError)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.part`)).toBe(false)
    // One retry (a transient corruption may succeed the second time), then it gives up.
    expect(requests).toHaveLength(2)
  })

  it('fails fast on non-retryable HTTP errors and on size mismatches', async () => {
    mode = 'missing'
    await expect(download({ url: `${base}/e`, dest: dest('e.bin'), quiet: true })).rejects.toThrow(
      /HTTP 404/,
    )
    expect(requests).toHaveLength(1)
    mode = 'ranges'
    await expect(
      download({ url: `${base}/f`, dest: dest('f.bin'), size: 5, retries: 0, quiet: true }),
    ).rejects.toThrow(/size mismatch/)
  })

  it('re-downloads with --force and detects a replaced file', async () => {
    const file = dest('g.bin')
    await download({ url: `${base}/g`, dest: file, sha256: digest, quiet: true })
    const forced = await download({
      url: `${base}/g`,
      dest: file,
      sha256: digest,
      force: true,
      quiet: true,
    })
    expect(forced.status).toBe('downloaded')
    // A different file in place (new mtime/size) invalidates the stamp and fails verification.
    writeFileSync(file, 'tampered')
    expect(await verifyExisting(file, digest)).toBeUndefined()
  })

  it('aborts promptly', async () => {
    const ac = new AbortController()
    ac.abort(new Error('stop'))
    await expect(
      download({ url: `${base}/h`, dest: dest('h.bin'), signal: ac.signal, quiet: true }),
    ).rejects.toThrow('stop')
  })
})

describe('whisper.cpp release selection', () => {
  const asset = (name: string, digest?: string): GhRelease['assets'][number] => ({
    name,
    size: 1,
    browser_download_url: `https://example.invalid/${name}`,
    ...(digest ? { digest: `sha256:${digest}` } : {}),
  })
  const win: HostInfo = {
    platform: 'win32',
    arch: 'x64',
    cpuOnly: false,
    hasNvidia: false,
    hasVulkan: true,
  }

  it('orders builds by expected speed and honours --cpu-only / forced builds', () => {
    expect(buildCandidates(win).map((c) => c.build)).toEqual(['vulkan', 'cpu', 'blas'])
    expect(buildCandidates({ ...win, hasNvidia: true }).map((c) => c.build)).toEqual([
      'cuda',
      'cuda',
      'vulkan',
      'cpu',
      'blas',
    ])
    expect(buildCandidates({ ...win, cpuOnly: true }).map((c) => c.build)).toEqual(['cpu', 'blas'])
    expect(buildCandidates(win, 'blas').map((c) => c.build)).toEqual(['blas'])
    expect(buildCandidates({ ...win, platform: 'darwin', arch: 'arm64' })).toEqual([])
  })

  it('reads the nightly tag linked from a stable release body', () => {
    expect(nightlyTagFromBody('Notes\n\n**Nightly build:** [b5454](https://github.com/x)')).toBe(
      'b5454',
    )
    expect(nightlyTagFromBody(undefined)).toBeUndefined()
  })

  it('takes binaries from the nightly build a binary-less stable release points to', () => {
    const releases: GhRelease[] = [
      {
        tag_name: 'b5460',
        draft: false,
        prerelease: true,
        published_at: '2026-10-03T00:00:00Z',
        assets: [asset('whisper-bin-x64.zip', 'f'.repeat(64))],
      },
      {
        tag_name: 'v1.9.5',
        draft: false,
        prerelease: false,
        published_at: '2026-10-02T00:00:00Z',
        body: '**Nightly build:** [b5454](https://github.com/ggml-org/whisper.cpp/releases/tag/b5454)',
        assets: [],
      },
      {
        tag_name: 'b5454',
        draft: false,
        prerelease: true,
        published_at: '2026-10-01T00:00:00Z',
        assets: [asset('whisper-blas-bin-x64.zip'), asset('whisper-bin-x64.zip', 'a'.repeat(64))],
      },
    ]
    const r = resolveBinary(releases, buildCandidates(win))
    expect(r).toMatchObject({
      version: 'v1.9.5',
      tag: 'b5454',
      build: 'cpu',
      sha256: 'a'.repeat(64),
    })
    expect(r?.asset.name).toBe('whisper-bin-x64.zip')
  })

  it('falls back to the newest release with a matching asset, ignoring drafts', () => {
    const releases: GhRelease[] = [
      {
        tag_name: 'v2',
        draft: true,
        prerelease: false,
        published_at: '2026-10-05T00:00:00Z',
        assets: [asset('whisper-bin-x64.zip')],
      },
      {
        tag_name: 'v1',
        draft: false,
        prerelease: false,
        published_at: '2026-10-01T00:00:00Z',
        assets: [],
      },
      {
        tag_name: 'b9',
        draft: false,
        prerelease: true,
        published_at: '2026-10-04T00:00:00Z',
        assets: [asset('whisper-bin-x64.zip')],
      },
    ]
    expect(resolveBinary(releases, buildCandidates(win))).toMatchObject({
      tag: 'b9',
      version: 'b9',
    })
    expect(resolveBinary(releases, [])).toBeUndefined()
  })
})

describe('prerequisite checks', () => {
  it('parses release, git and nightly FFmpeg versions', () => {
    expect(parseFfmpegVersion('ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright')).toEqual({
      version: '9.0.2-full_build-www.gyan.dev',
      major: 9,
    })
    expect(parseFfmpegVersion('ffmpeg version n7.1 Copyright').major).toBe(7)
    expect(parseFfmpegVersion('ffmpeg version N-120000-gabc Copyright').major).toBe(99)
    expect(parseFfmpegVersion('ffmpeg version 2026-10-01-git-abc-full_build').major).toBe(99)
    expect(parseFfmpegVersion('garbage')).toEqual({ version: 'unknown', major: 0 })
  })

  it('extracts names from -filters / -encoders listings', () => {
    const filters = parseCapabilityList(
      [
        'Filters:',
        '  T.. = Timeline support',
        ' ... scdet             V->V       Detect video scene change',
        ' TSC whisper           A->A       Transcribe audio',
      ].join('\n'),
    )
    expect(filters.has('scdet')).toBe(true)
    expect(filters.has('whisper')).toBe(true)
    const encoders = parseCapabilityList(
      ' V....D h264_amf             AMD AMF H.264 Encoder (codec h264)\r\n A....D aac   AAC\r\n',
    )
    expect([...encoders]).toEqual(['h264_amf', 'aac'])
  })

  it('requires Node 26+ with a fix hint', () => {
    expect(checkNode('26.13.0')).toMatchObject({ ok: true, detail: 'v26.13.0' })
    const old = checkNode('22.1.0')
    expect(old.ok).toBe(false)
    expect(old.fix).toBeTruthy()
  })
})

describe('terminal output', () => {
  it('formats sizes, durations, bars and tables', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150.0 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB')
    expect(formatDuration(75)).toBe('1m15s')
    expect(formatDuration(3720)).toBe('1h2m')
    expect(formatDuration(Number.NaN)).toBe('--')
    const bar = renderBar('model', 50, 100, 10, 10)
    expect(bar).toContain('█████░░░░░')
    expect(bar).toContain(' 50.0%')
    expect(bar).toContain('ETA 5s')
    expect(renderBar('x', 2048, undefined, 1024)).toBe('x  2 KB  1 KB/s')
    expect(formatTable(['A', 'Status'], [['whisper', 'ok']]).split('\n')).toEqual([
      'A        Status',
      '───────  ──────',
      'whisper  ok',
    ])
  })
})

const SETUP = fileURLToPath(new URL('../../../../scripts/setup.mjs', import.meta.url))

describe.skipIf(skipBecause(NO_FFMPEG))('setup.mjs (end to end)', () => {
  it('rejects unknown models and prints help', async () => {
    const run = promisify(execFile)
    const err = (await run(process.execPath, [SETUP, '--models', 'nope', '--data', DATA_DIR]).catch(
      (e: unknown) => e,
    )) as { code: number; stderr: string }
    expect(err.code).toBe(2)
    expect(err.stderr).toMatch(/Unknown model\(s\): nope/)
    const help = await run(process.execPath, [SETUP, '--help'])
    expect(help.stdout).toMatch(/--skip-models/)
  })

  // Installs (or, when already installed, re-verifies) whisper.cpp and the default + fast
  // models into the real data dir — the AI integration tests depend on them.
  it('installs the default toolchain idempotently', { timeout: 1_800_000 }, async () => {
    const run = promisify(execFile)
    const r = await run(process.execPath, [SETUP, '--data', DATA_DIR], { maxBuffer: 16 << 20 })
    expect(r.stderr).toMatch(/Component\s+Status\s+Details/)
    expect(r.stderr).toMatch(/whisper model large-v3-turbo-q5_0\s+(cached|downloaded|resumed)/)
    expect(r.stderr).toMatch(/whisper model base\s+(cached|downloaded|resumed)/)
    expect(r.stderr).toMatch(/face model \(YuNet\)\s+(cached|downloaded|resumed)/)
    expect(r.stderr).toMatch(/whisper\.cpp\s+(cached|installed|kept-offline)/)
    expect(
      existsSync(
        path.join(
          DATA_DIR,
          'bin',
          'whisper',
          process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli',
        ),
      ),
    ).toBe(true)
  })
})
