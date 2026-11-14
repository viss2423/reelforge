/** Removes the run's temp data dir and fixtures. */
import { rm } from 'node:fs/promises'
import { E2E_DIR } from './env.ts'

export default async function globalTeardown(): Promise<void> {
  // The server may still hold files open for a moment on Windows: retry, then give up
  // quietly (it's the OS temp dir).
  await rm(E2E_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(
    () => undefined,
  )
}
