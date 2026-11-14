/** Shared test utilities: temp dirs, FFmpeg discovery, lavfi fixtures, app/queue factories. */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DataPaths, JobDefinition, Toolchain } from '../src/contracts.ts'
import { dataPaths, ensureDataPaths } from '../src/config.ts'
import { SqliteStore } from '../src/db/store.ts'
import { EventBus } from '../src/jobs/events.ts'
import { JobQueue, type QueueDeps } from '../src/jobs/queue.ts'
import { silentLogger } from '../src/logger.ts'
import { FFMPEG_BASE, run } from '../src/media/ffmpeg.ts'
import { detectToolchain, type PlatformToolchain } from '../src/toolchain.ts'

export const log = silentLogger()

/** A fresh temp directory and its async cleanup. */
export const tempDir = async (
  prefix = 'rf-test-',
): Promise<{ dir: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  }
}

/** A temp data directory with all sub-directories created. */
export const tempData = async (): Promise<{ paths: DataPaths; cleanup: () => Promise<void> }> => {
  const { dir, cleanup } = await tempDir('rf-data-')
  const paths = dataPaths(dir)
  await ensureDataPaths(paths)
  return { paths, cleanup }
}

let toolchain: Promise<PlatformToolchain | undefined> | undefined
/** Real FFmpeg toolchain (no GPU probe), or undefined when FFmpeg is not installed. */
export const realToolchain = (): Promise<PlatformToolchain | undefined> => {
  toolchain ??= (async () => {
    const { paths, cleanup } = await tempData()
    try {
      return await detectToolchain({ paths, log, skipEncoderProbe: true })
    } catch {
      return undefined
    } finally {
      await cleanup()
    }
  })()
  return toolchain
}

/** Fake toolchain for tests that never spawn tools. */
export const fakeToolchain = (over: Partial<PlatformToolchain> = {}): PlatformToolchain => ({
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  ffmpegVersion: '9.0.2',
  ffmpegMajor: 9,
  hwEncoders: {},
  hwaccels: [],
  whisperModels: [],
  cpuThreads: 4,
  ...over,
})

/** Generates a media fixture with lavfi. `inputs`/`args` are raw FFmpeg arguments. */
export const lavfi = async (
  tools: Toolchain,
  output: string,
  inputs: string[],
  args: string[],
): Promise<string> => {
  await run(tools.ffmpeg, [...FFMPEG_BASE, ...inputs, ...args, output], { timeoutMs: 60_000 })
  return output
}

/** Store + bus + queue wired together on a temp data dir. */
export const makeQueue = async (
  definitions: JobDefinition[],
  over: Partial<QueueDeps> = {},
): Promise<{
  store: SqliteStore
  bus: EventBus
  queue: JobQueue
  paths: DataPaths
  cleanup: () => Promise<void>
}> => {
  const { paths, cleanup } = await tempData()
  const store = new SqliteStore(paths.db)
  const bus = new EventBus()
  const queue = new JobQueue({
    store,
    bus,
    paths: () => paths,
    tools: fakeToolchain(),
    log,
    definitions,
    ...over,
  })
  return {
    store,
    bus,
    queue,
    paths,
    cleanup: async () => {
      await queue.stop(1_000)
      store.close()
      await cleanup()
    },
  }
}

/** Resolves after `ms`. */
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls `fn` until it returns truthy (or throws after `timeoutMs`). */
export const waitFor = async <T>(
  fn: () => T | undefined | false,
  timeoutMs = 5_000,
): Promise<T> => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor timed out')
    await delay(10)
  }
}
