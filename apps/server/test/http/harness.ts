/** Builds the Fastify app over real services (temp data dir) for `inject`-driven route tests. */
import type { FastifyInstance } from 'fastify'
import type { DataPaths, JobDefinition } from '../../src/contracts.ts'
import { AuthService } from '../../src/auth/index.ts'
import { SqliteStore } from '../../src/db/store.ts'
import { buildApp } from '../../src/http/app.ts'
import { EventBus } from '../../src/jobs/events.ts'
import { JobQueue } from '../../src/jobs/queue.ts'
import { Uploads } from '../../src/media/uploads.ts'
import { PacksService } from '../../src/packs/service.ts'
import { fakeToolchain, log, tempData } from '../helpers.ts'

export interface Harness {
  app: FastifyInstance
  store: SqliteStore
  queue: JobQueue
  bus: EventBus
  auth: AuthService
  packs: PacksService
  uploads: Uploads
  paths: DataPaths
  token: string
  deviceId: string
  /** Authorization header of the pre-paired test device. */
  headers: { authorization: string }
  cleanup(): Promise<void>
}

export interface HarnessOptions {
  definitions?: JobDefinition[]
  webDist?: string
  bundledPacks?: string
  packsUrl?: string
  chunkSize?: number
  heartbeatMs?: number
}

export const UPLOAD_CHUNK = 1024

export const makeApp = async (opts: HarnessOptions = {}): Promise<Harness> => {
  const { paths, cleanup } = await tempData()
  const store = new SqliteStore(paths.db)
  const bus = new EventBus()
  const packs = new PacksService({
    root: paths.packs,
    bundledDir: opts.bundledPacks,
    url: opts.packsUrl ?? 'http://127.0.0.1:9/packs',
    appVersion: '0.1.0',
    log,
    bus,
    requestTimeoutMs: 2_000,
  })
  await packs.init()
  const tools = fakeToolchain()
  const queue = new JobQueue({
    store,
    bus,
    paths: () => paths,
    tools,
    log,
    definitions: opts.definitions ?? [],
  })
  queue.start()
  const uploads = new Uploads({
    store,
    paths,
    maxUploadBytes: 1024 * 1024,
    chunkSize: opts.chunkSize ?? UPLOAD_CHUNK,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
  })
  const auth = new AuthService(store)
  const app = await buildApp({
    version: '0.1.0',
    webDist: opts.webDist,
    paths,
    tools,
    store,
    queue,
    bus,
    uploads,
    auth,
    packs,
    log,
    urls: () => ['https://192.168.1.10:8443', 'https://localhost:8443'],
    tailscale: async () => ({ installed: false, running: false, ips: [] }),
    ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}),
  })
  await app.ready()
  const { token, deviceId } = auth.issue('Test phone')
  return {
    app,
    store,
    queue,
    bus,
    auth,
    packs,
    uploads,
    paths,
    token,
    deviceId,
    headers: { authorization: `Bearer ${token}` },
    cleanup: async () => {
      await app.close()
      await queue.stop(1_000)
      store.close()
      await cleanup()
    },
  }
}

/** Remote (LAN phone) client address for inject: not loopback. */
export const REMOTE = '192.168.1.50'
