/**
 * Structured logging with pino. JSON in production (one line per event, cheap to write);
 * `pino-pretty` only when attached to an interactive terminal in dev. When the server runs
 * headless (Windows autostart task) logs also go to `<data>/logs/server.log`, rotated once
 * at startup so a long-running host never fills the disk.
 */
import { mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { pino, type Logger as PinoLogger } from 'pino'
import type { Config } from './config.ts'

export type AppLogger = PinoLogger

const MAX_LOG_BYTES = 20 * 1024 * 1024

const rotate = (file: string): void => {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // no previous log file
  }
}

/** Creates the root logger for the server process. */
export const createLogger = (
  config: Pick<Config, 'logLevel' | 'prettyLogs' | 'dataDir'>,
): AppLogger => {
  const level = config.logLevel
  if (config.prettyLogs) {
    return pino({
      level,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    })
  }
  const streams: pino.StreamEntry[] = [{ level: level as pino.Level, stream: pino.destination(1) }]
  if (!process.stdout.isTTY) {
    const dir = path.join(config.dataDir, 'logs')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'server.log')
    rotate(file)
    streams.push({
      level: level as pino.Level,
      stream: pino.destination({ dest: file, sync: false, mkdir: true }),
    })
  }
  return pino({ level }, pino.multistream(streams))
}

/** A logger that discards everything (tests). */
export const silentLogger = (): AppLogger => pino({ level: 'silent' })
