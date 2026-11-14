/** Shared helpers for AI tests: synthetic signals, tool discovery, fake job contexts. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Asset, Job, ServerEvent } from '@reelforge/core'
import type { DataPaths, JobContext, Store, Toolchain } from '../../src/contracts.ts'

/** Deterministic PRNG (mulberry32) so noisy fixtures are reproducible. */
export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ClickTrackOptions {
  bpm: number
  seconds: number
  sampleRate: number
  /** Time of the first click in seconds. */
  offset?: number
  /** White noise amplitude (0 = none). */
  noise?: number
  /** Every `accentEvery`-th click (starting with the first) is louder and lower. */
  accentEvery?: number
  seed?: number
}

/** Click track: short decaying sine bursts on every beat. Returns samples + true beat times (s). */
export const clickTrack = (o: ClickTrackOptions): { samples: Float32Array; beats: number[] } => {
  const n = Math.round(o.seconds * o.sampleRate)
  const out = new Float32Array(n)
  const rand = rng(o.seed ?? 1)
  if (o.noise) for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * o.noise
  const beats: number[] = []
  const period = 60 / o.bpm
  const clickLen = Math.round(0.03 * o.sampleRate)
  for (
    let k = 0, t = o.offset ?? 0.5;
    t < o.seconds - 0.05;
    k++, t = (o.offset ?? 0.5) + k * period
  ) {
    beats.push(t)
    const accent = o.accentEvery ? k % o.accentEvery === 0 : false
    const freq = accent ? 600 : 1500
    const amp = accent ? 0.9 : 0.5
    const start = Math.round(t * o.sampleRate)
    for (let i = 0; i < clickLen && start + i < n; i++) {
      const env = Math.exp(-i / (0.006 * o.sampleRate))
      out[start + i] =
        (out[start + i] ?? 0) + amp * env * Math.sin((2 * Math.PI * freq * i) / o.sampleRate)
    }
  }
  return { samples: out, beats }
}

/** Locate a tool: `REELFORGE_<NAME>` env override, else PATH. */
const which = (name: string): string | undefined => {
  const env = process.env[`REELFORGE_${name.toUpperCase()}`]
  if (env && existsSync(env)) return env
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true })
    return name
  } catch {
    return undefined
  }
}

/** FFmpeg/ffprobe if installed (tests needing them are skipped otherwise, with a reason). */
export const FFMPEG = which('ffmpeg')
export const FFPROBE = which('ffprobe')
/** FFmpeg command for suites gated on NO_FFMPEG (never used when it is missing). */
export const FFMPEG_BIN = FFMPEG ?? 'ffmpeg'

/**
 * Skip gate that says why: returns true (skip) and prints `reason` when it is a string.
 * Usage: `describe.skipIf(skipBecause(!FFMPEG && 'ffmpeg not found'))(…)`.
 */
export const skipBecause = (reason: string | false | undefined): boolean => {
  if (!reason) return false
  console.warn(`[skip] ${reason}`)
  return true
}

/** Skip reason for FFmpeg-dependent suites (false when FFmpeg is available). */
export const NO_FFMPEG =
  !FFMPEG && 'ffmpeg not found on PATH (or REELFORGE_FFMPEG) — FFmpeg tests skipped'

/** Data dir that `pnpm bootstrap` populates (whisper, models). */
export const DATA_DIR = process.env.REELFORGE_DATA ?? path.join(os.homedir(), '.reelforge')

/** Run ffmpeg synchronously (fixture generation). */
export const ffmpeg = (args: string[]): void => {
  if (!FFMPEG) throw new Error('ffmpeg not available')
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
}

export const makeTempDir = (prefix: string): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `rf-${prefix}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** In-memory Store with just enough behaviour for job handlers. */
export class MemoryStore implements Store {
  readonly assets = new Map<string, Asset>()
  readonly settings = new Map<string, unknown>()
  getProject(): undefined {
    return undefined
  }
  listProjects(): [] {
    return []
  }
  saveProject(): number {
    return 0
  }
  deleteProject(): void {}
  getAsset(id: string): Asset | undefined {
    return this.assets.get(id)
  }
  listAssets(): Asset[] {
    return [...this.assets.values()]
  }
  putAsset(asset: Asset): void {
    this.assets.set(asset.id, asset)
  }
  patchAsset(id: string, patch: Partial<Asset>): Asset {
    const a = this.assets.get(id)
    if (!a) throw new Error(`no asset ${id}`)
    const next = { ...a, ...patch }
    this.assets.set(id, next)
    return next
  }
  deleteAsset(id: string): void {
    this.assets.delete(id)
  }
  getJob(): undefined {
    return undefined
  }
  listJobs(): [] {
    return []
  }
  putJob(): void {}
  getSetting<T>(key: string): T | undefined {
    return this.settings.get(key) as T | undefined
  }
  setSetting<T>(key: string, value: T): void {
    this.settings.set(key, value)
  }
}

export const makePaths = (root: string): DataPaths => ({
  root,
  db: path.join(root, 'reelforge.sqlite'),
  media: path.join(root, 'media'),
  exports: path.join(root, 'exports'),
  packs: path.join(root, 'packs'),
  models: path.join(DATA_DIR, 'models'),
  bin: path.join(DATA_DIR, 'bin'),
  certs: path.join(root, 'certs'),
  tmp: path.join(root, 'tmp'),
})

export const makeAsset = (id: string, name: string, extra: Partial<Asset> = {}): Asset => ({
  id,
  kind: 'video',
  name,
  size: 0,
  mime: 'video/mp4',
  createdAt: new Date(0).toISOString(),
  hasAudio: true,
  hasVideo: true,
  proxy: 'pending',
  thumbnails: 'pending',
  waveform: 'pending',
  ...extra,
})

/** Place a generated file as an asset's original in a test data dir. */
export const addAssetFile = (
  paths: DataPaths,
  store: MemoryStore,
  asset: Asset,
  src: string,
): void => {
  const dir = path.join(paths.media, asset.id)
  mkdirSync(dir, { recursive: true })
  copyFileSync(src, path.join(dir, `original${path.extname(asset.name)}`))
  store.putAsset(asset)
}

export interface FakeContext<P> extends JobContext<P> {
  events: ServerEvent[]
  progressLog: Array<{ p: number; message?: string }>
}

/** A JobContext wired to the MemoryStore, recording progress and events. */
export const makeContext = <P>(
  kind: Job['kind'],
  payload: P,
  paths: DataPaths,
  store: Store,
  tools: Partial<Toolchain> = {},
  signal: AbortSignal = new AbortController().signal,
): FakeContext<P> => {
  const events: ServerEvent[] = []
  const progressLog: Array<{ p: number; message?: string }> = []
  const noop = (): void => {}
  return {
    job: { id: 'job1', kind, status: 'running', progress: 0, createdAt: new Date(0).toISOString() },
    payload,
    signal,
    progress: (p, message) => {
      progressLog.push(message === undefined ? { p } : { p, message })
    },
    paths,
    tools: {
      ffmpeg: FFMPEG ?? 'ffmpeg',
      ffprobe: FFPROBE ?? 'ffprobe',
      ffmpegVersion: 'test',
      hwEncoders: {},
      whisperModels: [],
      cpuThreads: os.availableParallelism(),
      ...tools,
    },
    store,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    enqueue: () => {
      throw new Error('enqueue not supported in tests')
    },
    emit: (e) => events.push(e),
    events,
    progressLog,
  }
}
