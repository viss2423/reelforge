/**
 * Parallel generation of the CPU-heavy pack art (LUT cubes and sticker PNGs).
 *
 * Both are pure JS per-pixel/per-sample work (~8 s single-threaded), so jobs are fanned out
 * to a pool of worker threads; this module is both the pool (main thread) and the worker.
 * Each job is deterministic, so the parallel output is byte-identical to a serial run.
 */
import { availableParallelism } from 'node:os'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { LOOKS, buildCube } from './luts.mjs'
import { STICKERS, renderSticker } from './stickers.mjs'

/** @typedef {{ kind: 'lut', ref: string, title: string } | { kind: 'sticker', index: number }} Job */

/** Produce the bytes of one job (runs inside a worker). */
function run(job) {
  if (job.kind === 'lut') {
    const ops = LOOKS[job.ref]
    if (!ops) throw new Error(`no look ${job.ref}`)
    return Buffer.from(buildCube(job.title, ops))
  }
  const recipe = STICKERS[job.index]
  if (!recipe) throw new Error(`no sticker #${job.index}`)
  return renderSticker(recipe)
}

if (!isMainThread && parentPort) {
  const port = parentPort
  port.on('message', (/** @type {{ id: number, job: Job }} */ { id, job }) => {
    try {
      const bytes = run(job)
      // Transfer the buffer instead of copying it back to the main thread.
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      port.postMessage({ id, bytes: ab }, [ab])
    } catch (e) {
      port.postMessage({ id, error: String(e?.stack ?? e) })
    }
  })
}

/**
 * Run jobs on a worker pool; resolves to one Buffer per job, in job order.
 * @param {Job[]} jobs
 * @returns {Promise<Buffer[]>}
 */
export async function generateAll(jobs) {
  const size = Math.max(1, Math.min(availableParallelism(), jobs.length))
  const workers = Array.from({ length: size }, () => new Worker(new URL(import.meta.url)))
  const results = Array.from({ length: jobs.length })
  let next = 0
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise((resolve, reject) => {
            const feed = () => {
              if (next >= jobs.length) return resolve(undefined)
              const id = next++
              // worker_threads Worker, not a window: there is no targetOrigin.
              // oxlint-disable-next-line unicorn/require-post-message-target-origin
              w.postMessage({ id, job: jobs[id] })
            }
            w.on('message', (msg) => {
              if (msg.error) return reject(new Error(msg.error))
              results[msg.id] = Buffer.from(msg.bytes)
              feed()
            })
            w.on('error', reject)
            feed()
          }),
      ),
    )
  } finally {
    await Promise.all(workers.map((w) => w.terminate()))
  }
  return results
}

/** Job list: every look in LOOKS and every sticker recipe. */
export const allJobs = (lutTitle) => [
  ...Object.keys(LOOKS).map((ref) => ({ kind: 'lut', ref, title: lutTitle(ref) })),
  ...STICKERS.map((_, index) => ({ kind: 'sticker', index })),
]
