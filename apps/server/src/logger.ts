/**
 * Structured logging with pino. JSON in production (one line per event, cheap to write);
 * `pino-pretty` only when attached to an interactive terminal in dev.
 *
 * stdout is the log. Process supervisors capture it — the Windows autostart launcher
 * redirects it to `<data>\logs\server.log` and rotates that file — so the server does not
 * open the same file itself (on Windows that collides with the redirect: EBUSY at startup).
 * Set LOG_FILE to additionally write to a file of your choice, rotated once at startup.
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
  config: Pick<Config, 'logLevel' | 'prettyLogs'> & { logFile?: string | undefined },
): AppLogger => {
  const level = config.logLevel
  if (config.prettyLogs) {
    return pino({
      level,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    })
  }
  if (!config.logFile) return pino({ level }, pino.destination(1))
  mkdirSync(path.dirname(config.logFile), { recursive: true })
  rotate(config.logFile)
  const streams: pino.StreamEntry[] = [
    { level: level as pino.Level, stream: pino.destination(1) },
    {
      level: level as pino.Level,
      stream: pino.destination({ dest: config.logFile, sync: false, mkdir: true }),
    },
  ]
  return pino({ level }, pino.multistream(streams))
}

/** A logger that discards everything (tests). */
export const silentLogger = (): AppLogger => pino({ level: 'silent' })
