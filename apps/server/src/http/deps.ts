/** Everything the HTTP layer needs, injected so the app can be built in tests with `inject`. */
import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { AuthService } from '../auth/index.ts'
import type { DataPaths } from '../contracts.ts'
import type { DeviceRecord, SqliteStore } from '../db/store.ts'
import type { EventBus } from '../jobs/events.ts'
import type { JobQueue } from '../jobs/queue.ts'
import type { AppLogger } from '../logger.ts'
import type { Uploads } from '../media/uploads.ts'
import type { TailscaleStatus } from '../net/tailscale.ts'
import type { PacksService } from '../packs/service.ts'
import type { PlatformToolchain } from '../toolchain.ts'
import { HttpError } from './errors.ts'

export interface AppDeps {
  version: string
  /** Built PWA directory, if any. */
  webDist: string | undefined
  paths: DataPaths
  tools: PlatformToolchain
  store: SqliteStore
  queue: JobQueue
  bus: EventBus
  uploads: Uploads
  auth: AuthService
  packs: PacksService
  log: AppLogger
  /** Reachable base URLs of the HTTPS server (LAN first). */
  urls: () => string[]
  tailscale?: () => Promise<TailscaleStatus>
  /** TLS material; omitted → plain HTTP (tests). */
  https?: { key: string; cert: string }
  /** WebSocket heartbeat interval (ms). */
  heartbeatMs?: number
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated device (set by the auth hook on protected routes). */
    device: DeviceRecord | null
  }
  interface FastifyContextConfig {
    /** Route is reachable without a device token. */
    public?: boolean
  }
}

/** The authenticated device; throws 401 when absent (defensive — the hook enforces it). */
export const deviceOf = (req: FastifyRequest): DeviceRecord => {
  if (!req.device) throw new HttpError(401, 'unauthorized', 'device token required')
  return req.device
}

/** Parses with a zod schema (ZodError → 400 by the error handler). */
export const parse = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> =>
  schema.parse(value)
