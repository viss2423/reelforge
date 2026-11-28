/**
 * Queue throughput. A timing test: it runs in the serial "heavy" group (vitest.config.ts),
 * so nothing else competes for the CPU or the disk while it measures.
 */
import { afterEach, expect, it } from 'vitest'
import { makeQueue } from '../helpers.ts'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

// Typically under 1 s on the host (enqueue, run and persist every job in SQLite).
it('schedules thousands of jobs quickly', async () => {
  let done = 0
  const q = await makeQueue([
    {
      kind: 'probe',
      resource: 'io',
      defaultPriority: 50,
      handler: async () => {
        done++
      },
    },
  ])
  cleanup = q.cleanup
  const t0 = performance.now()
  for (let i = 0; i < 2_000; i++) q.queue.enqueue('probe', {}, { priority: i % 7 })
  q.queue.start()
  await q.queue.idle()
  const ms = performance.now() - t0
  console.info(`[queue.perf] 2000 jobs enqueued+run+persisted in ${Math.round(ms)} ms`)
  expect(done).toBe(2_000)
  expect(ms).toBeLessThan(5_000)
})
