/**
 * Removes the run's generated fixtures. The data dir is left for the next run's global
 * setup to sweep: Playwright stops the web server only AFTER global teardown, and on
 * Windows the server's open SQLite files make a recursive delete retry (and block the
 * runner) for minutes.
 */
import { rm } from 'node:fs/promises'
import { E2E_FIXTURES } from './env.ts'

export default async function globalTeardown(): Promise<void> {
  await rm(E2E_FIXTURES, { recursive: true, force: true }).catch(() => undefined)
}
