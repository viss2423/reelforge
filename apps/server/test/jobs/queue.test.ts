import type { Job, JobKind, ServerEvent } from '@reelforge/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { JobContext, JobDefinition, ResourceClass } from '../../src/contracts.ts'
import { JobQueue, UnknownJobKindError } from '../../src/jobs/queue.ts'
import { mergeDefinitions } from '../../src/jobs/registry.ts'
import { delay, fakeToolchain, log, makeQueue, waitFor } from '../helpers.ts'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}
const deferred = (): Deferred => {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A controllable handler: every started job is recorded and blocks until released, and
 * rejects when its signal aborts (like a well-behaved FFmpeg job).
 */
const controllable = () => {
  const started: string[] = []
  const gates = new Map<string, Deferred>()
  const running = new Set<string>()
  let maxConcurrent = 0
  const handler = async (ctx: JobContext): Promise<unknown> => {
    started.push((ctx.payload as { name: string }).name)
    const gate = deferred()
    gates.set(ctx.job.id, gate)
    running.add(ctx.job.id)
    maxConcurrent = Math.max(maxConcurrent, running.size)
    const onAbort = (): void => gate.reject(ctx.signal.reason as Error)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await gate.promise
      return { ok: (ctx.payload as { name: string }).name }
    } finally {
      running.delete(ctx.job.id)
    }
  }
  return {
    started,
    gates,
    handler,
    get maxConcurrent() {
      return maxConcurrent
    },
    release: (id: string) => gates.get(id)?.resolve(),
  }
}

const def = (
  kind: JobKind,
  resource: ResourceClass,
  handler: JobDefinition['handler'],
  defaultPriority = 50,
): JobDefinition => ({
  kind,
  resource,
  defaultPriority,
  handler,
})

let cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups) await c()
  cleanups = []
})

const setup = async (defs: JobDefinition[], over: Parameters<typeof makeQueue>[1] = {}) => {
  const q = await makeQueue(defs, over)
  cleanups.push(q.cleanup)
  return q
}

describe('JobQueue', () => {
  it('runs by priority then FIFO within a resource class', async () => {
    const c = controllable()
    const { queue, store } = await setup([def('export', 'gpu-encode', c.handler)])
    const a = queue.enqueue('export', { name: 'a' }, { priority: 50 })
    const b = queue.enqueue('export', { name: 'b' }, { priority: 50 })
    const urgent = queue.enqueue('export', { name: 'urgent' }, { priority: 1 })
    const c2 = queue.enqueue('export', { name: 'c' }, { priority: 50 })
    queue.start()
    for (const id of [urgent.id, a.id, b.id, c2.id]) {
      await waitFor(() => c.gates.has(id))
      c.release(id)
    }
    await queue.idle()
    expect(c.started).toEqual(['urgent', 'a', 'b', 'c'])
    expect(c.maxConcurrent).toBe(1)
    expect(store.getJob(a.id)).toMatchObject({ status: 'done', progress: 1, result: { ok: 'a' } })
  })

  it('enforces per-class concurrency independently', async () => {
    const cpu = controllable()
    const io = controllable()
    const { queue } = await setup([
      def('silence', 'cpu', cpu.handler),
      def('probe', 'io', io.handler),
    ])
    queue.start()
    const cpuJobs = Array.from({ length: 5 }, (_, i) => queue.enqueue('silence', { name: `c${i}` }))
    const ioJobs = Array.from({ length: 6 }, (_, i) => queue.enqueue('probe', { name: `i${i}` }))
    await waitFor(() => cpu.started.length === 2 && io.started.length === 4)
    await delay(20)
    expect(cpu.started.length).toBe(2)
    expect(io.started.length).toBe(4)
    expect(queue.stats().cpu).toEqual({ running: 2, queued: 3, limit: 2 })
    for (const j of [...cpuJobs, ...ioJobs]) {
      await waitFor(() => cpu.gates.has(j.id) || io.gates.has(j.id))
      cpu.release(j.id)
      io.release(j.id)
    }
    await queue.idle()
    expect(cpu.maxConcurrent).toBe(2)
    expect(io.maxConcurrent).toBe(4)
  })

  it('honours configured concurrency overrides', async () => {
    const c = controllable()
    const { queue } = await setup([def('export', 'gpu-encode', c.handler)], {
      concurrency: { 'gpu-encode': 2 },
    })
    queue.start()
    const jobs = [0, 1, 2].map((i) => queue.enqueue('export', { name: String(i) }))
    await waitFor(() => c.started.length === 2)
    for (const j of jobs) {
      await waitFor(() => c.gates.has(j.id))
      c.release(j.id)
    }
    await queue.idle()
    expect(c.maxConcurrent).toBe(2)
  })

  it('cancels queued and running jobs', async () => {
    const c = controllable()
    const { queue, store, bus } = await setup([def('export', 'gpu-encode', c.handler)])
    const events: ServerEvent[] = []
    bus.subscribe((e) => events.push(e))
    queue.start()
    const running = queue.enqueue('export', { name: 'running' })
    const queued = queue.enqueue('export', { name: 'queued' })
    await waitFor(() => c.gates.has(running.id))
    expect(queue.cancel(queued.id)?.status).toBe('cancelled')
    expect(queue.cancel(running.id)?.id).toBe(running.id)
    await queue.idle()
    expect(store.getJob(running.id)?.status).toBe('cancelled')
    expect(store.getJob(queued.id)?.status).toBe('cancelled')
    expect(c.started).toEqual(['running'])
    expect(queue.cancel('unknown')).toBeUndefined()
    // cancelling a finished job is a no-op that returns it
    expect(queue.cancel(running.id)?.status).toBe('cancelled')
    const statuses = events
      .filter((e) => e.type === 'job' && e.job.id === running.id)
      .map((e) => (e as { job: Job }).job.status)
    expect(statuses).toEqual(['queued', 'running', 'cancelled'])
  })

  it('a preemptible background job yields its slot to more urgent work, then resumes', async () => {
    const c = controllable()
    const { queue, store } = await setup([
      { ...def('trends', 'ai', c.handler, 200), preemptible: true },
      def('matte', 'ai', c.handler, 50),
    ])
    queue.start()
    const bg = queue.enqueue('trends', { name: 'trends' })
    await waitFor(() => c.gates.has(bg.id))
    const user = queue.enqueue('matte', { name: 'matte' })
    // The user's job starts at once; the background run is paused, not cancelled.
    await waitFor(() => c.gates.has(user.id))
    expect(store.getJob(bg.id)).toMatchObject({ status: 'queued' })
    c.release(user.id)
    await waitFor(() => c.started.length === 3)
    expect(c.started).toEqual(['trends', 'matte', 'trends'])
    c.release(bg.id)
    await queue.idle()
    expect(store.getJob(bg.id)?.status).toBe('done')
    expect(store.getJob(user.id)?.status).toBe('done')
  })

  it('never preempts jobs that are not preemptible, or for equal/lower priority work', async () => {
    const c = controllable()
    const { queue } = await setup([
      def('export', 'gpu-encode', c.handler, 50),
      { ...def('trends', 'ai', c.handler, 200), preemptible: true },
      def('matte', 'ai', c.handler, 250),
    ])
    queue.start()
    const exp = queue.enqueue('export', { name: 'export' })
    const bg = queue.enqueue('trends', { name: 'trends' })
    await waitFor(() => c.gates.has(exp.id) && c.gates.has(bg.id))
    // Urgent, but the running export is not preemptible; the waiting AI job is less urgent.
    queue.enqueue('export', { name: 'export-urgent' }, { priority: 1 })
    queue.enqueue('matte', { name: 'matte-later' })
    await delay(20)
    expect(c.started.toSorted()).toEqual(['export', 'trends'])
    c.release(exp.id)
    c.release(bg.id)
    await waitFor(() => c.started.length === 4)
    for (const id of c.gates.keys()) c.release(id)
    await queue.idle()
  })

  it('cancelWhere cancels every matching active job', async () => {
    const c = controllable()
    const { queue, store } = await setup([def('proxy', 'gpu-encode', c.handler)])
    queue.start()
    const a = queue.enqueue('proxy', { name: 'a' }, { assetId: 'x' })
    const b = queue.enqueue('proxy', { name: 'b' }, { assetId: 'x' })
    const other = queue.enqueue('proxy', { name: 'o' }, { assetId: 'y' })
    await waitFor(() => c.gates.has(a.id))
    expect(queue.cancelWhere((j) => j.assetId === 'x')).toBe(2)
    await waitFor(() => c.gates.has(other.id))
    c.release(other.id)
    await queue.idle()
    expect([a, b, other].map((j) => store.getJob(j.id)?.status)).toEqual([
      'cancelled',
      'cancelled',
      'done',
    ])
  })

  it('marks failures with the error message', async () => {
    const { queue, store } = await setup([
      def('probe', 'io', async () => {
        throw new Error('ffprobe exploded')
      }),
    ])
    queue.start()
    const j = queue.enqueue('probe', {})
    await queue.idle()
    expect(store.getJob(j.id)).toMatchObject({ status: 'failed', error: 'ffprobe exploded' })
  })

  it('throttles progress (≥200 ms or ≥1 %) and always flushes the latest value', async () => {
    let now = 0
    const gate = deferred()
    let ctxRef: JobContext | undefined
    const { queue, bus, store } = await setup(
      [
        def('proxy', 'gpu-encode', async (ctx) => {
          ctxRef = ctx
          await gate.promise
        }),
      ],
      { clock: () => now, progressIntervalMs: 200 },
    )
    const progress: number[] = []
    bus.subscribe((e) => {
      if (e.type === 'job' && e.job.status === 'running') progress.push(e.job.progress)
    })
    queue.start()
    const j = queue.enqueue('proxy', {})
    await waitFor(() => ctxRef)
    progress.length = 0
    const ctx = ctxRef!
    ctx.progress(0.001) // tiny, no time passed → deferred
    ctx.progress(0.002)
    expect(progress).toEqual([])
    ctx.progress(0.02, 'Encoding') // ≥1 % delta → immediate
    expect(progress).toEqual([0.02])
    now += 250
    ctx.progress(0.021) // ≥200 ms → immediate
    expect(progress).toEqual([0.02, 0.021])
    ctx.progress(0.022) // deferred: trailing flush after the interval
    expect(progress.length).toBe(2)
    await waitFor(() => progress.length === 3, 1_000)
    expect(progress[2]).toBe(0.022)
    expect(store.getJob(j.id)).toMatchObject({ progress: 0.022, message: 'Encoding' })
    ctx.progress(Number.NaN)
    ctx.progress(5, undefined, 1_234.6)
    expect(queue.active(j.id)).toMatchObject({ progress: 1, eta: 1_235 })
    gate.resolve()
    await queue.idle()
    expect(store.getJob(j.id)).toMatchObject({ status: 'done', progress: 1 })
    expect(store.getJob(j.id)).not.toHaveProperty('eta')
  })

  it('lets handlers enqueue follow-up jobs and emit events', async () => {
    const seen: string[] = []
    const { queue, bus } = await setup([
      def('probe', 'io', async (ctx) => {
        ctx.enqueue('thumbnails', { assetId: 'a' }, { assetId: 'a' })
        ctx.emit({ type: 'packs', version: 'x' })
      }),
      def('thumbnails', 'cpu', async (ctx) => {
        seen.push(ctx.job.assetId ?? '')
      }),
    ])
    const events: string[] = []
    bus.subscribe((e) => events.push(e.type))
    queue.start()
    queue.enqueue('probe', {})
    await waitFor(() => seen.length === 1)
    await queue.idle()
    expect(seen).toEqual(['a'])
    expect(events).toContain('packs')
  })

  it('rejects unknown kinds and duplicate definitions', async () => {
    const { queue } = await setup([def('probe', 'io', async () => undefined)])
    expect(() => queue.enqueue('export', {})).toThrow(UnknownJobKindError)
    expect(queue.has('probe')).toBe(true)
    expect(queue.has('nope')).toBe(false)
    const d = def('probe', 'io', async () => undefined)
    expect(() => mergeDefinitions([d], [d])).toThrow(/duplicate/)
    expect(
      () =>
        new JobQueue({
          store: undefined as never,
          bus: undefined as never,
          paths: () => undefined as never,
          tools: fakeToolchain(),
          log,
          definitions: [d, d],
        }),
    ).toThrow(/duplicate/)
  })

  it('recovers after a crash: requeues running jobs once, then fails them', async () => {
    const ran: string[] = []
    const defs = [
      def('probe', 'io', async (ctx) => {
        ran.push(ctx.job.id)
      }),
    ]
    const { store, queue: first } = await setup(defs)
    // Simulate a crash: jobs persisted as running/queued with no live queue.
    const now = new Date().toISOString()
    const mk = (id: string, status: Job['status'], attempts: number): void => {
      store.insertJob({ id, kind: 'probe', status, progress: 0.5, createdAt: now }, {}, 10)
      store.setJobAttempts(id, attempts)
    }
    mk('crashed-once', 'running', 1)
    mk('crashed-twice', 'running', 2)
    mk('waiting', 'queued', 0)
    store.insertJob(
      { id: 'alien', kind: 'reframe', status: 'queued', progress: 0, createdAt: now },
      {},
      10,
    )
    void first
    const queue = new JobQueue({
      store,
      bus: { emit: () => {} } as never,
      paths: () => undefined as never,
      tools: fakeToolchain(),
      log,
      definitions: defs,
    })
    expect(queue.recover()).toEqual({ queued: 1, requeued: 1, failed: 2 })
    expect(store.getJob('crashed-twice')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/interrupted/),
    })
    expect(store.getJob('alien')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/unsupported/),
    })
    expect(store.getJob('crashed-once')).toMatchObject({ status: 'queued', progress: 0 })
    queue.start()
    await queue.idle()
    expect(ran.sort()).toEqual(['crashed-once', 'waiting'])
    expect(store.getJob('crashed-once')?.status).toBe('done')
  })

  it('stop() aborts running jobs and persists them as resumable without spending an attempt', async () => {
    const c = controllable()
    const { queue, store } = await setup([def('export', 'gpu-encode', c.handler)])
    queue.start()
    const j = queue.enqueue('export', { name: 'long' })
    await waitFor(() => c.gates.has(j.id))
    await queue.stop(1_000)
    expect(store.getJob(j.id)).toMatchObject({ status: 'queued', progress: 0 })
    expect(store.getJobRecord(j.id)?.attempts).toBe(0)
    // a new queue picks it up
    const again = controllable()
    const next = new JobQueue({
      store,
      bus: { emit: () => {} } as never,
      paths: () => undefined as never,
      tools: fakeToolchain(),
      log,
      definitions: [def('export', 'gpu-encode', again.handler)],
    })
    expect(next.recover()).toEqual({ queued: 1, requeued: 0, failed: 0 })
    next.start()
    await waitFor(() => again.gates.has(j.id))
    again.release(j.id)
    await next.idle()
    expect(store.getJob(j.id)?.status).toBe('done')
  })

  it('stop() gives up on handlers that ignore abort and leaves the store consistent', async () => {
    const never = deferred()
    const { queue, store } = await setup([def('export', 'gpu-encode', () => never.promise)])
    queue.start()
    const j = queue.enqueue('export', {})
    await waitFor(() => store.getJob(j.id)?.status === 'running')
    const t0 = performance.now()
    await queue.stop(50)
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(store.getJob(j.id)?.status).toBe('queued')
    never.resolve() // late settlement must not overwrite the persisted state
    await delay(10)
    expect(store.getJob(j.id)?.status).toBe('queued')
  })

  it('schedules thousands of jobs quickly', async () => {
    let done = 0
    const { queue } = await setup([
      def('probe', 'io', async () => {
        done++
      }),
    ])
    const t0 = performance.now()
    for (let i = 0; i < 2_000; i++) queue.enqueue('probe', {}, { priority: i % 7 })
    queue.start()
    await queue.idle()
    const ms = performance.now() - t0
    console.info(`[queue.test] 2000 jobs enqueued+run+persisted in ${Math.round(ms)} ms`)
    expect(done).toBe(2_000)
    expect(ms).toBeLessThan(10_000)
  })
})
