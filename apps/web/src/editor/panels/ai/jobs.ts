/**
 * Host job runner for the AI tools: enqueue → follow progress over the WebSocket → resolve
 * with the finished job. A slow poll backs the socket up (missed events while a phone
 * sleeps or the socket reconnects), so a flow can never hang on a lost event.
 */
import type { Job, JobKind } from '@reelforge/core'
import { sleep } from '@/lib/backoff.ts'

export interface JobInput {
  kind: JobKind
  payload: unknown
  projectId?: string
  assetId?: string
}

/** The slice of the API client the runner needs (injectable for tests). */
export interface JobApi {
  createJob(input: JobInput): Promise<Job>
  job(id: string, signal?: AbortSignal): Promise<Job>
  cancelJob(id: string): Promise<void>
}

/** The slice of the event socket the runner needs. */
export interface JobEvents {
  on(type: 'job', cb: (e: { type: 'job'; job: Job }) => void): () => void
}

export interface JobDeps {
  api: JobApi
  events: JobEvents
  /** Poll interval backing up the socket (ms). */
  pollMs?: number
}

export class JobFailedError extends Error {
  readonly job: Job
  constructor(job: Job) {
    super(
      job.error ?? (job.status === 'cancelled' ? 'Cancelled on the host' : 'The host job failed'),
    )
    this.name = 'JobFailedError'
    this.job = job
  }
}

const isFinal = (j: Job) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')

/**
 * Runs one host job to completion. `onProgress` receives 0..1. Aborting cancels the job on
 * the host (best effort) and rejects with the abort reason.
 */
export const runJob = (
  deps: JobDeps,
  input: JobInput,
  opts: { onProgress?: (p: number, job: Job) => void; signal?: AbortSignal } = {},
): Promise<Job> => {
  const { signal } = opts
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise<Job>((resolve, reject) => {
    let id: string | undefined
    let settled = false
    let lastProgress = -1
    // Events can beat the createJob response; keep the newest per id until we know ours.
    const early = new Map<string, Job>()
    const stopPoll = new AbortController()

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      off()
      stopPoll.abort()
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const update = (job: Job) => {
      if (settled) return
      if (job.status === 'done') {
        opts.onProgress?.(1, job)
        finish(() => resolve(job))
      } else if (isFinal(job)) {
        finish(() => reject(new JobFailedError(job)))
      } else if (job.progress !== lastProgress) {
        lastProgress = job.progress
        opts.onProgress?.(job.progress, job)
      }
    }
    const off = deps.events.on('job', (e) => {
      if (id === undefined) early.set(e.job.id, e.job)
      else if (e.job.id === id) update(e.job)
    })
    const onAbort = () => {
      if (id !== undefined) void deps.api.cancelJob(id).catch(() => undefined)
      finish(() => reject(abortError(signal!)))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const poll = async (jobId: string) => {
      const every = deps.pollMs ?? 4000
      while (!settled) {
        try {
          await sleep(every, stopPoll.signal)
        } catch {
          return
        }
        try {
          update(await deps.api.job(jobId, stopPoll.signal))
        } catch {
          // Transient (offline, host restarting): the socket or the next poll will catch up.
        }
      }
    }

    deps.api.createJob(input).then(
      (job) => {
        if (settled) {
          // Aborted while the request was in flight: don't leave the job running.
          void deps.api.cancelJob(job.id).catch(() => undefined)
          return
        }
        id = job.id
        update(early.get(job.id) && !isFinal(job) ? early.get(job.id)! : job)
        early.clear()
        if (!settled) void poll(job.id)
      },
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    )
  })
}

/**
 * Runs several jobs in parallel (the host's queue schedules them by resource class) and
 * reports the mean progress. The first failure cancels the rest and rejects.
 */
export const runJobs = async (
  deps: JobDeps,
  inputs: readonly JobInput[],
  opts: { onProgress?: (p: number) => void; signal?: AbortSignal } = {},
): Promise<Job[]> => {
  if (inputs.length === 0) return []
  const progress = new Float64Array(inputs.length)
  const inner = new AbortController()
  const forward = () => inner.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', forward, { once: true })
  const report = () => {
    let sum = 0
    for (const p of progress) sum += p
    opts.onProgress?.(sum / inputs.length)
  }
  try {
    return await Promise.all(
      inputs.map((input, i) =>
        runJob(deps, input, {
          signal: inner.signal,
          onProgress: (p) => {
            progress[i] = p
            report()
          },
        }).catch((err: unknown) => {
          inner.abort(err)
          throw err
        }),
      ),
    )
  } finally {
    opts.signal?.removeEventListener('abort', forward)
  }
}
