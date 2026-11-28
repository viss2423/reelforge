/**
 * Server composition root: config → store → toolchain → queue (+ recovery) → packs →
 * certificates → HTTPS app + HTTP landing server. `startServer` returns a handle whose
 * `close()` shuts everything down in order; `index.ts` adds signals and the banner.
 */
import type { AddressInfo } from 'node:net'
import type { Server as HttpsServer } from 'node:https'
import type { FastifyInstance } from 'fastify'
import { sharedLlm, shutdownLlms } from './ai/llm/index.ts'
import { AuthService } from './auth/index.ts'
import { type Config, dataPaths, ensureDataPaths } from './config.ts'
import type { DataPaths } from './contracts.ts'
import { SqliteStore } from './db/store.ts'
import { buildApp } from './http/app.ts'
import { EventBus } from './jobs/events.ts'
import { runMaintenance } from './jobs/maintenance.ts'
import { JobQueue } from './jobs/queue.ts'
import { allJobDefinitions } from './jobs/registry.ts'
import type { AppLogger } from './logger.ts'
import { Uploads } from './media/uploads.ts'
import { CertManager, hostSans } from './net/certs.ts'
import { hostAddresses, hostName, httpsUrls, primaryLanAddress } from './net/interfaces.ts'
import { configureMusic } from './music/index.ts'
import { buildLandingApp } from './net/landing.ts'
import { MDNS_NAME, startMdns } from './net/mdns.ts'
import { detectTailscale } from './net/tailscale.ts'
import { PacksService } from './packs/service.ts'
import { detectToolchain, type EncoderCache, type PlatformToolchain } from './toolchain.ts'
import type { LlmPort } from './trends/llm-port.ts'
import { TrendsService, trendsJob, type TrendsSettings } from './trends/service.ts'

/**
 * Listens and returns the bound port. The default host '::' is dual stack: `localhost`
 * and `.local` names can resolve to IPv6 first, and some clients (WebKit) don't fall back
 * to IPv4. A host without IPv6 binds 0.0.0.0 instead.
 */
const listen = async (app: FastifyInstance, port: number, host: string): Promise<number> => {
  try {
    await app.listen({ port, host })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (host !== '::' || (code !== 'EAFNOSUPPORT' && code !== 'EADDRNOTAVAIL')) throw err
    await app.listen({ port, host: '0.0.0.0' })
  }
  return (app.server.address() as AddressInfo).port
}

const ENCODER_CACHE_KEY = 'toolchain.encoders'
const MAINTENANCE_INTERVAL_MS = 3_600_000
const INTERFACE_POLL_MS = 30_000

export interface ServerHandle {
  config: Config
  paths: DataPaths
  tools: PlatformToolchain
  store: SqliteStore
  queue: JobQueue
  packs: PacksService
  trends: TrendsService
  auth: AuthService
  app: FastifyInstance
  landing: FastifyInstance
  /** Actual bound ports (differ from config when 0 was requested). */
  httpsPort: number
  httpPort: number
  /** CA certificate (PEM) clients must trust. */
  caPem: string
  /** Reachable HTTPS base URLs (LAN first). */
  urls: () => string[]
  close(): Promise<void>
}

export interface StartOptions {
  log: AppLogger
  /** Skip the startup pack sync (tests, offline). */
  syncPacks?: boolean
  /** Local LLM for the trend engine (default: the shared llama.cpp instance; ranking/remix only when no model is installed). */
  llm?: LlmPort
  /** Don't schedule trend refreshes (tests). Manual refreshes still work. */
  scheduleTrends?: boolean
}

const TRENDS_SETTINGS_KEY = 'trends.settings'

/** Boots the whole server. Throws (after cleaning up) when a step fails. */
export const startServer = async (config: Config, opts: StartOptions): Promise<ServerHandle> => {
  const { log } = opts
  const paths = dataPaths(config.dataDir)
  await ensureDataPaths(paths)
  const cleanup: Array<() => Promise<void> | void> = []
  const fail = async (err: unknown): Promise<never> => {
    for (const fn of cleanup.toReversed()) await Promise.resolve(fn()).catch(() => undefined)
    throw err
  }

  try {
    const store = new SqliteStore(paths.db)
    cleanup.push(() => store.close())

    const t0 = performance.now()
    const tools = await detectToolchain({
      paths,
      log,
      ffmpegPath: config.ffmpegPath,
      skipEncoderProbe: config.skipEncoderProbe,
      cache: {
        get: () => store.getSetting<EncoderCache>(ENCODER_CACHE_KEY),
        set: (v) => store.setSetting(ENCODER_CACHE_KEY, v),
      },
    })
    log.info(
      {
        ffmpeg: tools.ffmpegVersion,
        hwEncoders: tools.hwEncoders,
        ms: Math.round(performance.now() - t0),
      },
      'toolchain ready',
    )

    const bus = new EventBus((err) => log.error({ err }, 'event listener failed'))
    const packs = new PacksService({
      root: paths.packs,
      bundledDir: config.repoPacksDir,
      url: config.packsUrl,
      appVersion: config.version,
      log,
      bus,
    })
    await packs.init()
    cleanup.push(() => {
      packs.stop()
      return packs.idle()
    })

    const trends = new TrendsService({
      dataRoot: paths.root,
      packs,
      config: config.trends,
      llm: opts.llm ?? sharedLlm(paths, log),
      log,
      ffmpeg: tools.ffmpeg,
      userAgent: `ReelForge/${config.version} (self-hosted trend engine; +https://github.com/viss2423/reelforge)`,
      settings: {
        get: () => store.getSetting<TrendsSettings>(TRENDS_SETTINGS_KEY),
        set: (v) => store.setSetting(TRENDS_SETTINGS_KEY, v),
      },
    })
    await trends.init()
    configureMusic({
      online: config.musicOnline,
      jamendoClientId: config.jamendoClientId,
      log,
      trendSounds: () => trends.soundProfiles(),
    })
    cleanup.push(() => {
      trends.stop()
      return trends.idle()
    })

    const queue = new JobQueue({
      store,
      bus,
      // Jobs see the currently active pack tree (it changes when a sync lands).
      paths: () => ({ ...paths, packs: packs.dir ?? paths.packs }),
      tools,
      log,
      definitions: [...allJobDefinitions(), trendsJob(() => trends)],
      concurrency: { 'gpu-encode': config.gpuEncodeConcurrency },
    })
    const recovered = queue.recover()
    if (recovered.queued + recovered.requeued + recovered.failed > 0)
      log.info(recovered, 'recovered jobs from previous run')
    queue.start()
    // Reverse order: the queue stops (aborting LLM jobs) before the model process is killed.
    cleanup.push(() => shutdownLlms())
    cleanup.push(() => queue.stop())
    trends.start(queue, { schedule: opts.scheduleTrends !== false })

    const maintain = (): void => {
      runMaintenance({
        store,
        paths,
        log,
        jobRetentionMs: config.jobRetentionMs,
        exportRetentionMs: config.exportRetentionMs,
        isActiveJob: (id) => queue.active(id) !== undefined,
      }).then(
        (report) => log.debug(report, 'maintenance done'),
        (err: unknown) => log.warn({ err }, 'maintenance failed'),
      )
    }
    const maintenanceTimer = setInterval(maintain, MAINTENANCE_INTERVAL_MS)
    maintenanceTimer.unref()
    cleanup.push(() => clearInterval(maintenanceTimer))
    maintain()

    const uploads = new Uploads({ store, paths, maxUploadBytes: config.maxUploadBytes })
    const auth = new AuthService(store, { fixedCode: config.testPairCode })
    if (config.testPairCode) log.warn('test pairing code enabled (REELFORGE_TEST_PAIR_CODE)')

    const hostname = hostName()
    const certs = new CertManager({
      dir: paths.certs,
      hostname,
      log,
      sans: async () => {
        const ts = await detectTailscale()
        return hostSans({
          hostname,
          ips: [...hostAddresses().map((a) => a.address), ...ts.ips],
          extraDns: ts.dnsName ? [ts.dnsName] : [],
        })
      },
    })
    const tls = await certs.init()
    cleanup.push(() => certs.stop())

    let httpsPort = config.httpsPort
    const portSuffix = (): string => (httpsPort === 443 ? '' : `:${httpsPort}`)
    const urls = (): string[] => [
      ...httpsUrls(httpsPort),
      ...(config.mdns ? [`https://${MDNS_NAME}${portSuffix()}`] : []),
      `https://${hostname}.local${portSuffix()}`,
      `https://localhost${portSuffix()}`,
    ]
    const app = await buildApp({
      version: config.version,
      webDist: config.webDist,
      paths,
      tools,
      store,
      queue,
      bus,
      uploads,
      auth,
      packs,
      trends,
      log,
      urls,
      tailscale: () => detectTailscale(),
      https: { key: tls.key, cert: tls.cert },
    })
    cleanup.push(() => app.close())
    httpsPort = await listen(app, config.httpsPort, config.host)

    // New LAN address / Wi-Fi network → new leaf, swapped into live TLS without a restart.
    certs.watch(INTERFACE_POLL_MS, (next) => {
      ;(app.server as unknown as HttpsServer).setSecureContext({ key: next.key, cert: next.cert })
      log.info({ sans: next.sans }, 'TLS certificate hot-swapped')
    })

    const landing = buildLandingApp({
      httpsPort,
      caDer: () => certs.tls.caDer,
      fallbackHost: () => primaryLanAddress() ?? 'localhost',
      log,
    })
    cleanup.push(() => landing.close())
    const httpPort = await listen(landing, config.httpPort, config.host)

    if (config.mdns) {
      const mdns = startMdns({ log })
      cleanup.push(() => mdns.stop())
    }

    if (opts.syncPacks !== false && config.packsSync) packs.start(config.packsSyncIntervalMs)

    let closing: Promise<void> | undefined
    return {
      config,
      paths,
      tools,
      store,
      queue,
      packs,
      trends,
      auth,
      app,
      landing,
      httpsPort,
      httpPort,
      caPem: tls.ca,
      urls,
      close: () =>
        (closing ??= (async () => {
          // Stop accepting first, then let jobs persist their state, then close the DB.
          for (const fn of cleanup.toReversed()) {
            try {
              await fn()
            } catch (err) {
              log.warn({ err }, 'shutdown step failed')
            }
          }
        })()),
    }
  } catch (err) {
    return fail(err)
  }
}
