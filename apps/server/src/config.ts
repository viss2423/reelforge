/**
 * Server configuration: environment variables + defaults, and the data-directory layout.
 * Everything is resolved once at boot into a plain, immutable `Config` object so the rest
 * of the server never reads `process.env` directly (which keeps modules testable).
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DataPaths } from './contracts.ts'
import type { TrendsConfig } from './trends/service.ts'
import pkg from '../package.json' with { type: 'json' }

/** Server version reported by /api/health, the WebSocket hello and the startup banner. */
export const SERVER_VERSION: string = pkg.version

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Repository root (apps/server/src → ../../..). */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

export interface Config {
  version: string
  dataDir: string
  httpPort: number
  httpsPort: number
  host: string
  /** Base URL that serves `index.json` and `<packId>/pack.json` (raw GitHub by default). */
  packsUrl: string
  /** 0 disables periodic sync (startup + manual sync still run). */
  packsSyncIntervalMs: number
  logLevel: string
  /** Pretty, human-readable logs (dev). Production logs are JSON. */
  prettyLogs: boolean
  /**
   * Optional extra log file (env LOG_FILE). Off by default: stdout is the log, and the
   * Windows autostart launcher redirects it to `<data>\logs\server.log` (which also captures
   * crash stack traces). Never point this at a file the launcher already redirects into.
   */
  logFile?: string | undefined
  maxUploadBytes: number
  /** Concurrent GPU encodes (AMF/NVENC have limited sessions; 1 keeps exports fast). */
  gpuEncodeConcurrency: number
  /** Finished jobs older than this are pruned. */
  jobRetentionMs: number
  /** Finished export jobs (and their MP4s) older than this are pruned. */
  exportRetentionMs: number
  /** Built PWA (apps/web/dist); undefined when it has not been built yet. */
  webDist: string | undefined
  /** Repo `./packs` used as a fallback when nothing has been synced yet (dev / offline). */
  repoPacksDir: string
  /** Advertise `reelforge.local` over mDNS. */
  mdns: boolean
  /** Skip real GPU test encodes (tests / CI without GPUs). */
  skipEncoderProbe: boolean
  /** Explicit FFmpeg location (binary or directory). */
  ffmpegPath: string | undefined
  /** Pull packs from `packsUrl` (false = serve the synced/bundled tree as is). */
  packsSync: boolean
  /**
   * Test-only fixed pairing code that `POST /api/pair` accepts any number of times
   * (end-to-end runs). Never set in production.
   */
  testPairCode: string | undefined
  /** Search royalty-free music catalogues online (REELFORGE_MUSIC_ONLINE, default on). */
  musicOnline: boolean
  /** Optional free Jamendo API client id (REELFORGE_JAMENDO_CLIENT_ID). */
  jamendoClientId: string | undefined
  /** Local trend engine (src/trends). */
  trends: TrendsConfig
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Parses "6h", "30m", "1500ms", "45" (seconds) → milliseconds. */
export const parseDuration = (value: string): number => {
  const m = DURATION.exec(value.trim())
  if (!m?.[1]) throw new Error(`invalid duration: ${value}`)
  return Math.round(Number(m[1]) * (UNIT_MS[(m[2] ?? 's').toLowerCase()] ?? 1_000))
}

const SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i
const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
}

/** Parses "20GB", "512mb", "1048576" → bytes. */
export const parseSize = (value: string): number => {
  const m = SIZE.exec(value.trim())
  if (!m?.[1]) throw new Error(`invalid size: ${value}`)
  return Math.round(Number(m[1]) * (UNIT_BYTES[(m[2] ?? 'b').toLowerCase()] ?? 1))
}

const port = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 65_535) throw new Error(`invalid ${name}: ${value}`)
  return n
}

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value)

const expandHome = (p: string): string =>
  p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p

/** `REELFORGE_<name>` wins over the bare `<name>` (namespaced vars for tests / shared hosts). */
const pick = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  env[`REELFORGE_${name}`] || env[name] || undefined

const PAIR_CODE = /^[0-9]{6}$/

/** Builds the immutable server configuration from environment variables. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const dataDir = path.resolve(
    expandHome(env.REELFORGE_DATA || path.join(os.homedir(), '.reelforge')),
  )
  const webDist = path.resolve(pick(env, 'WEB_DIST') ?? path.join(REPO_ROOT, 'apps', 'web', 'dist'))
  const production = env.NODE_ENV === 'production'
  const testPairCode = env.REELFORGE_TEST_PAIR_CODE || undefined
  if (testPairCode !== undefined && !PAIR_CODE.test(testPairCode))
    throw new Error(`invalid REELFORGE_TEST_PAIR_CODE (6 digits): ${testPairCode}`)
  if (testPairCode !== undefined && production)
    throw new Error('REELFORGE_TEST_PAIR_CODE must not be set in production')
  const packsUrl = (
    env.PACKS_URL || 'https://raw.githubusercontent.com/viss2423/reelforge/main/packs'
  ).replace(/\/+$/, '')
  return Object.freeze({
    version: SERVER_VERSION,
    dataDir,
    httpPort: port(pick(env, 'HTTP_PORT'), 8080, 'HTTP_PORT'),
    httpsPort: port(pick(env, 'HTTPS_PORT'), 8443, 'HTTPS_PORT'),
    host: env.HOST || '0.0.0.0',
    packsUrl,
    packsSyncIntervalMs: parseDuration(env.PACKS_SYNC_INTERVAL || '6h'),
    logLevel: env.LOG_LEVEL || 'info',
    prettyLogs: bool(env.LOG_PRETTY, !production && process.stdout.isTTY === true),
    logFile: env.LOG_FILE ? path.resolve(env.LOG_FILE) : undefined,
    maxUploadBytes: parseSize(env.MAX_UPLOAD_SIZE || '20GB'),
    gpuEncodeConcurrency: Math.max(1, Number(env.GPU_ENCODE_CONCURRENCY) || 1),
    jobRetentionMs: parseDuration(env.JOB_RETENTION || '7d'),
    exportRetentionMs: parseDuration(env.EXPORT_RETENTION || '30d'),
    webDist: existsSync(path.join(webDist, 'index.html')) ? webDist : undefined,
    repoPacksDir: path.join(REPO_ROOT, 'packs'),
    mdns: bool(env.MDNS, false),
    skipEncoderProbe: bool(env.SKIP_ENCODER_PROBE, false),
    ffmpegPath: env.FFMPEG_PATH || undefined,
    packsSync: bool(pick(env, 'PACKS_SYNC'), true),
    testPairCode,
    musicOnline: bool(pick(env, 'MUSIC_ONLINE'), true),
    jamendoClientId: pick(env, 'JAMENDO_CLIENT_ID'),
    trends: trendsConfig(env, packsUrl),
  })
}

/** `TRENDS*`, `PUBLISH_TRENDS*` and the optional free source keys. */
export const trendsConfig = (env: NodeJS.ProcessEnv, packsUrl: string): TrendsConfig => {
  const hour = Number(pick(env, 'TRENDS_HOUR') ?? 4)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new Error(`invalid TRENDS_HOUR (0-23): ${pick(env, 'TRENDS_HOUR')}`)
  const publish = pick(env, 'PUBLISH_TRENDS')
  if (publish !== undefined && publish !== 'github' && publish !== 'off')
    throw new Error(`invalid PUBLISH_TRENDS (github|off): ${publish}`)
  const mode = pick(env, 'PUBLISH_TRENDS_MODE') ?? 'pr'
  if (mode !== 'pr' && mode !== 'main')
    throw new Error(`invalid PUBLISH_TRENDS_MODE (pr|main): ${mode}`)
  // Same repository the packs are pulled from, unless told otherwise.
  const fromPacks = /raw\.githubusercontent\.com\/([^/]+\/[^/]+)\//.exec(packsUrl)?.[1]
  return {
    enabled: bool(pick(env, 'TRENDS'), true),
    region: (pick(env, 'TRENDS_REGION') ?? 'US').toUpperCase().slice(0, 2),
    hour,
    youtubeKey: pick(env, 'YOUTUBE_API_KEY'),
    redditId: pick(env, 'REDDIT_CLIENT_ID'),
    redditSecret: pick(env, 'REDDIT_CLIENT_SECRET'),
    publish: publish === 'github' ? 'github' : undefined,
    publishMode: mode,
    publishRepo: pick(env, 'PUBLISH_TRENDS_REPO') ?? fromPacks,
    soundPreview: bool(pick(env, 'TRENDS_SOUND_PREVIEW'), false),
  }
}

/** Canonical data-directory layout (see contracts.ts DataPaths). */
export const dataPaths = (root: string): DataPaths => ({
  root,
  db: path.join(root, 'reelforge.sqlite'),
  media: path.join(root, 'media'),
  exports: path.join(root, 'exports'),
  packs: path.join(root, 'packs'),
  models: path.join(root, 'models'),
  bin: path.join(root, 'bin'),
  certs: path.join(root, 'certs'),
  tmp: path.join(root, 'tmp'),
})

/** Creates every data directory (except `packs`, which only exists once a sync succeeded). */
export const ensureDataPaths = async (paths: DataPaths): Promise<void> => {
  await Promise.all(
    [paths.media, paths.exports, paths.models, paths.bin, paths.certs, paths.tmp].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  )
}
