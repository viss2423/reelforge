import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  dataPaths,
  ensureDataPaths,
  loadConfig,
  parseDuration,
  parseSize,
  REPO_ROOT,
  SERVER_VERSION,
} from '../src/config.ts'
import { tempDir } from './helpers.ts'

describe('config', () => {
  it('parses durations and sizes', () => {
    expect(parseDuration('6h')).toBe(21_600_000)
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('1500ms')).toBe(1_500)
    expect(parseDuration('45')).toBe(45_000)
    expect(parseDuration(' 1.5 D ')).toBe(129_600_000)
    expect(() => parseDuration('soon')).toThrow(/invalid duration/)
    expect(parseSize('20GB')).toBe(20 * 1024 ** 3)
    expect(parseSize('512mb')).toBe(512 * 1024 ** 2)
    expect(parseSize('1048576')).toBe(1_048_576)
    expect(() => parseSize('-1')).toThrow(/invalid size/)
  })

  it('applies documented defaults', () => {
    const c = loadConfig({ NODE_ENV: 'production' })
    expect(c).toMatchObject({
      version: SERVER_VERSION,
      dataDir: path.join(os.homedir(), '.reelforge'),
      httpPort: 8080,
      httpsPort: 8443,
      host: '::',
      packsUrl: 'https://raw.githubusercontent.com/viss2423/reelforge/main/packs',
      packsSyncIntervalMs: 6 * 3_600_000,
      logLevel: 'info',
      prettyLogs: false,
      gpuEncodeConcurrency: 1,
      mdns: false,
      skipEncoderProbe: false,
      ffmpegPath: undefined,
      repoPacksDir: path.join(REPO_ROOT, 'packs'),
      packsSync: true,
      testPairCode: undefined,
    })
    expect(Object.isFrozen(c)).toBe(true)
    expect(existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('reads overrides from the environment', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      await writeFile(path.join(dir, 'index.html'), '<!doctype html>')
      const c = loadConfig({
        REELFORGE_DATA: '~/rf-data',
        HTTP_PORT: '0',
        HTTPS_PORT: '9443',
        HOST: '127.0.0.1',
        PACKS_URL: 'http://localhost:9000/packs///',
        PACKS_SYNC_INTERVAL: '0',
        LOG_LEVEL: 'debug',
        LOG_PRETTY: 'yes',
        MAX_UPLOAD_SIZE: '1GB',
        GPU_ENCODE_CONCURRENCY: '2',
        WEB_DIST: dir,
        MDNS: '1',
        SKIP_ENCODER_PROBE: 'true',
        FFMPEG_PATH: 'C:\\ffmpeg\\bin',
      })
      expect(c).toMatchObject({
        dataDir: path.join(os.homedir(), 'rf-data'),
        httpPort: 0,
        httpsPort: 9443,
        host: '127.0.0.1',
        packsUrl: 'http://localhost:9000/packs',
        packsSyncIntervalMs: 0,
        logLevel: 'debug',
        prettyLogs: true,
        maxUploadBytes: 1024 ** 3,
        gpuEncodeConcurrency: 2,
        webDist: path.resolve(dir),
        mdns: true,
        skipEncoderProbe: true,
        ffmpegPath: 'C:\\ffmpeg\\bin',
      })
      // A dist directory without index.html is treated as "not built".
      expect(loadConfig({ WEB_DIST: path.join(dir, 'nope') }).webDist).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('prefers REELFORGE_-namespaced variables (end-to-end runs)', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      await writeFile(path.join(dir, 'index.html'), '<!doctype html>')
      const c = loadConfig({
        HTTP_PORT: '1',
        HTTPS_PORT: '2',
        REELFORGE_HTTP_PORT: '18080',
        REELFORGE_HTTPS_PORT: '18443',
        WEB_DIST: path.join(dir, 'nope'),
        REELFORGE_WEB_DIST: dir,
        REELFORGE_TEST_PAIR_CODE: '246810',
        REELFORGE_PACKS_SYNC: 'off',
      })
      expect(c).toMatchObject({
        httpPort: 18080,
        httpsPort: 18443,
        webDist: path.resolve(dir),
        testPairCode: '246810',
        packsSync: false,
      })
      expect(loadConfig({ PACKS_SYNC: '0' }).packsSync).toBe(false)
      expect(loadConfig({ REELFORGE_PACKS_SYNC: 'on' }).packsSync).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('rejects malformed test pairing codes and refuses them in production', () => {
    expect(() => loadConfig({ REELFORGE_TEST_PAIR_CODE: '12345' })).toThrow(/6 digits/)
    expect(() =>
      loadConfig({ REELFORGE_TEST_PAIR_CODE: '123456', NODE_ENV: 'production' }),
    ).toThrow(/production/)
  })

  it('rejects invalid ports', () => {
    expect(() => loadConfig({ HTTP_PORT: '70000' })).toThrow(/HTTP_PORT/)
    expect(() => loadConfig({ HTTPS_PORT: 'abc' })).toThrow(/HTTPS_PORT/)
  })

  it('lays out and creates the data directory (packs only appear after a sync)', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const paths = dataPaths(dir)
      expect(paths.db).toBe(path.join(dir, 'reelforge.sqlite'))
      await mkdir(paths.root, { recursive: true })
      await ensureDataPaths(paths)
      for (const d of [paths.media, paths.exports, paths.models, paths.bin, paths.certs, paths.tmp])
        expect(existsSync(d)).toBe(true)
      expect(existsSync(paths.packs)).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
