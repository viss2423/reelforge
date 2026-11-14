/**
 * ReelForge server entry point: boots everything, prints the startup banner with LAN URLs and
 * a terminal QR code for pairing a phone, and shuts down gracefully on SIGINT/SIGTERM.
 */
import QRCode from 'qrcode'
import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { pairUrl } from './http/routes/auth.ts'
import { primaryLanAddress } from './net/interfaces.ts'
import { startServer, type ServerHandle } from './server.ts'

const SHUTDOWN_TIMEOUT_MS = 10_000

const banner = async (server: ServerHandle): Promise<string> => {
  const { code } = server.auth.pairing.current()
  const lan = primaryLanAddress()
  const portSuffix = (port: number, def: number): string => (port === def ? '' : `:${port}`)
  const pairTarget = pairUrl(
    lan ? `https://${lan}${portSuffix(server.httpsPort, 443)}` : server.urls()[0]!,
    code,
  )
  const qr = await QRCode.toString(pairTarget, { type: 'terminal', small: true })
  const setup = lan ? `http://${lan}${portSuffix(server.httpPort, 80)}` : undefined
  const lines = [
    '',
    `  ReelForge ${server.config.version} is running`,
    '',
    ...server.urls().map((u) => `    ${u}`),
    '',
    `  Pair a phone: scan the QR code (code ${code}, valid 5 minutes).`,
    ...(setup ? [`  First time on a device? Open ${setup} to install the certificate.`] : []),
    `  Data: ${server.paths.root}`,
    '',
    qr,
  ]
  return lines.join('\n')
}

const main = async (): Promise<void> => {
  const config = loadConfig()
  const log = createLogger(config)
  let server: ServerHandle
  try {
    server = await startServer(config, { log })
  } catch (err) {
    log.error({ err }, 'ReelForge failed to start')
    process.exitCode = 1
    return
  }
  // The banner is for humans at a terminal; headless (autostart) runs only log the URLs.
  if (process.stdout.isTTY) process.stdout.write(`${await banner(server)}\n`)
  else log.info({ urls: server.urls() }, 'ReelForge is running')

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    log.info({ signal }, 'shutting down')
    const force = setTimeout(() => {
      log.error('shutdown timed out; exiting')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    force.unref()
    server.close().then(
      () => {
        log.flush()
        process.exitCode = 0
      },
      (err: unknown) => {
        log.error({ err }, 'shutdown failed')
        process.exitCode = 1
      },
    )
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  // Windows console close / Ctrl+Break.
  process.once('SIGBREAK', () => shutdown('SIGBREAK'))
}

await main()
