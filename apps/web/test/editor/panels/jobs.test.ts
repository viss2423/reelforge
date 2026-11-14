/** Host job runner: WS progress, early events, poll fallback, failure and cancellation. */
import type { Job } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JobFailedError,
  runJob,
  runJobs,
  type JobApi,
  type JobDeps,
} from '@/editor/panels/ai/jobs.ts'
import { flushMicrotasks } from '../../fixtures.ts'
import { makeJob } from './helpers.ts'

type Listener = (e: { type: 'job'; job: Job }) => void

/** Fake API + socket. `createJob` resolves when the test calls `resolveCreate`. */
const harness = (opts: { deferCreate?: boolean } = {}) => {
  const listeners = new Set<Listener>()
  const jobs = new Map<string, Job>()
  let n = 0
  const pendingCreates: Array<() => void> = []
  const api = {
    createJob: vi.fn<JobApi['createJob']>((input) => {
      const job = makeJob({ id: `j${++n}`, kind: input.kind, status: 'queued' })
      jobs.set(job.id, job)
      if (!opts.deferCreate) return Promise.resolve(job)
      return new Promise<Job>((resolve) => pendingCreates.push(() => resolve(job)))
    }),
    job: vi.fn<JobApi['job']>((id: string) => Promise.resolve(jobs.get(id)!)),
    cancelJob: vi.fn<JobApi['cancelJob']>(() => Promise.resolve()),
  }
  const deps: JobDeps = {
    api,
    events: {
      on: (_type, cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
    pollMs: 1000,
  }
  const emit = (id: string, patch: Partial<Job>) => {
    const job = { ...jobs.get(id)!, ...patch }
    jobs.set(id, job)
    for (const l of listeners) l({ type: 'job', job })
  }
  /** Changes the host-side job without an event (only a poll sees it). */
  const silently = (id: string, patch: Partial<Job>) => jobs.set(id, { ...jobs.get(id)!, ...patch })
  const resolveCreate = () => pendingCreates.shift()?.()
  return { api, deps, emit, silently, listeners, resolveCreate }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('runJob', () => {
  it('reports progress from socket events and resolves with the done job', async () => {
    const h = harness()
    const progress: number[] = []
    const p = runJob(
      h.deps,
      { kind: 'silence', payload: {} },
      { onProgress: (v) => progress.push(v) },
    )
    await flushMicrotasks()
    h.emit('j1', { status: 'running', progress: 0.25 })
    h.emit('j1', { status: 'running', progress: 0.25 }) // duplicate: not re-reported
    h.emit('j2', { status: 'running', progress: 0.9 }) // someone else's job
    h.emit('j1', { status: 'done', progress: 1, result: { ok: 1 } })
    await expect(p).resolves.toMatchObject({ id: 'j1', result: { ok: 1 } })
    expect(progress).toEqual([0, 0.25, 1])
    expect(h.listeners.size).toBe(0)
  })

  it('uses events that beat the createJob response', async () => {
    const h = harness({ deferCreate: true })
    const p = runJob(h.deps, { kind: 'beats', payload: {} })
    await flushMicrotasks()
    h.emit('j1', { status: 'done', progress: 1, result: 'early' })
    h.resolveCreate()
    await expect(p).resolves.toMatchObject({ result: 'early' })
  })

  it('falls back to polling when socket events are missed', async () => {
    const h = harness()
    const p = runJob(h.deps, { kind: 'scenes', payload: {} })
    await flushMicrotasks()
    h.silently('j1', { status: 'done', progress: 1, result: [1] })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toMatchObject({ result: [1] })
    expect(h.api.job).toHaveBeenCalledTimes(1)
    // Polling stops once settled.
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.api.job).toHaveBeenCalledTimes(1)
  })

  it('survives transient poll errors', async () => {
    const h = harness()
    h.api.job.mockRejectedValueOnce(new Error('offline'))
    const p = runJob(h.deps, { kind: 'scenes', payload: {} })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1000)
    h.silently('j1', { status: 'done', progress: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toMatchObject({ status: 'done' })
  })

  it('rejects with JobFailedError carrying the host message', async () => {
    const h = harness()
    const p = runJob(h.deps, { kind: 'transcribe', payload: {} })
    await flushMicrotasks()
    h.emit('j1', { status: 'failed', error: 'whisper model missing' })
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JobFailedError)
    expect((err as JobFailedError).message).toBe('whisper model missing')
    expect((err as JobFailedError).job.id).toBe('j1')
  })

  it('treats a host-side cancel as failure', async () => {
    const h = harness()
    const p = runJob(h.deps, { kind: 'reframe', payload: {} })
    await flushMicrotasks()
    h.emit('j1', { status: 'cancelled' })
    await expect(p).rejects.toThrow('Cancelled on the host')
  })

  it('aborting cancels the host job and rejects', async () => {
    const h = harness()
    const ac = new AbortController()
    const p = runJob(h.deps, { kind: 'silence', payload: {} }, { signal: ac.signal })
    await flushMicrotasks()
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.api.cancelJob).toHaveBeenCalledWith('j1')
  })

  it('aborting before the job exists cancels it once created', async () => {
    const h = harness({ deferCreate: true })
    const ac = new AbortController()
    const p = runJob(h.deps, { kind: 'silence', payload: {} }, { signal: ac.signal })
    ac.abort(new Error('stop'))
    await expect(p).rejects.toThrow('stop')
    h.resolveCreate()
    await flushMicrotasks()
    expect(h.api.cancelJob).toHaveBeenCalledWith('j1')
  })

  it('rejects immediately for an already-aborted signal and on create failure', async () => {
    const h = harness()
    await expect(
      runJob(h.deps, { kind: 'silence', payload: {} }, { signal: AbortSignal.abort() }),
    ).rejects.toBeDefined()
    expect(h.api.createJob).not.toHaveBeenCalled()
    h.api.createJob.mockRejectedValueOnce('host down')
    await expect(runJob(h.deps, { kind: 'silence', payload: {} })).rejects.toThrow('host down')
  })
})

describe('runJobs', () => {
  it('reports mean progress across jobs and resolves in input order', async () => {
    const h = harness()
    const progress: number[] = []
    const p = runJobs(
      h.deps,
      [
        { kind: 'silence', payload: 1 },
        { kind: 'silence', payload: 2 },
      ],
      { onProgress: (v) => progress.push(v) },
    )
    await flushMicrotasks()
    h.emit('j2', { status: 'running', progress: 0.5 })
    h.emit('j1', { status: 'done', progress: 1, result: 'a' })
    h.emit('j2', { status: 'done', progress: 1, result: 'b' })
    const jobs = await p
    expect(jobs.map((j) => j.result)).toEqual(['a', 'b'])
    expect(progress.at(-1)).toBe(1)
    expect(progress).toContain(0.25)
    expect(progress).toContain(0.75)
  })

  it('cancels the remaining jobs on the first failure', async () => {
    const h = harness()
    const p = runJobs(h.deps, [
      { kind: 'silence', payload: 1 },
      { kind: 'silence', payload: 2 },
    ])
    await flushMicrotasks()
    h.emit('j1', { status: 'failed', error: 'bad audio' })
    await expect(p).rejects.toThrow('bad audio')
    expect(h.api.cancelJob).toHaveBeenCalledWith('j2')
  })

  it('returns [] without calling the host for no inputs', async () => {
    const h = harness()
    await expect(runJobs(h.deps, [])).resolves.toEqual([])
    expect(h.api.createJob).not.toHaveBeenCalled()
  })
})
