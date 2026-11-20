import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from '../src/logger.ts'

describe('createLogger', () => {
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rf-logger-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('does not open a log file by default (supervisors redirect stdout to it)', () => {
    const dir = tempDir()
    const logger = createLogger({ logLevel: 'info', prettyLogs: false })
    logger.info('hello')
    // Regression: the server used to open <data>/logs/server.log itself whenever stdout was
    // not a TTY, colliding with the autostart launcher's redirect (EBUSY on Windows).
    expect(existsSync(path.join(dir, 'logs'))).toBe(false)
  })

  it('also writes JSON lines to LOG_FILE when configured', async () => {
    const file = path.join(tempDir(), 'nested', 'server.log')
    const logger = createLogger({ logLevel: 'info', prettyLogs: false, logFile: file })
    logger.info({ answer: 42 }, 'to file')
    await new Promise<void>((resolve) => logger.flush(() => resolve()))
    await new Promise((r) => setTimeout(r, 50))
    const line = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1) ?? '{}') as {
      msg?: string
      answer?: number
    }
    expect(line).toMatchObject({ msg: 'to file', answer: 42 })
  })
})
