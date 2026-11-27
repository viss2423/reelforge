/**
 * Persistent job queue with resource-class scheduling.
 *
 * - Each job kind belongs to a resource class (io / cpu / gpu-encode / ai); the queue runs at
 *   most `concurrency[class]` jobs of a class at once, so an export never starves proxy
 *   generation and GPU encoders are never oversubscribed (AMF has few sessions).
 * - Within a class: lowest `priority` first, FIFO (insertion sequence) among equals.
 * - Preemption: a running `preemptible` job yields its slot to a more urgent queued job of
 *   its class (aborted and requeued without counting the attempt), so a long background
 *   run never makes the user wait for background removal or Auto Edit.
 * - Cancellation through `AbortController`; handlers must honour `ctx.signal`.
 * - Progress is throttled (emit when ≥ `progressIntervalMs` passed or progress moved ≥ 1 %,
 *   with a trailing flush so the latest value is never lost) and persisted on every emit.
 * - Crash recovery: a job found `running` at startup was interrupted; it is requeued once,
 *   and failed if it is interrupted again (protects against jobs that crash the process).
 */
import type { Job, JobKind } from '@reelforge/core'
import { newId } from '@reelforge/core'
import type {
  DataPaths,
  JobContext,
  JobDefinition,
  ResourceClass,
  Toolchain,
} from '../contracts.ts'
import type { SqliteStore } from '../db/store.ts'
import type { AppLogger } from '../logger.ts'
import type { EventBus } from './events.ts'

export const DEFAULT_CONCURRENCY: Readonly<Record<ResourceClass, number>> = {
  io: 4,
  cpu: 2,
  'gpu-encode': 1,
  ai: 1,
}

const CLASSES = Object.keys(DEFAULT_CONCURRENCY) as ResourceClass[]
/** A job interrupted this many times by restarts is failed instead of requeued. */
const MAX_INTERRUPTED_ATTEMPTS = 2

export class UnknownJobKindError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`unsupported job kind: ${kind}`)
    this.kind = kind
  }
}

export interface EnqueueOptions {
  projectId?: string
  assetId?: string
  priority?: number
}

export interface QueueDeps {
  store: SqliteStore
  bus: EventBus
  /** Resolved for every job start (the active packs directory can change at runtime). */
  paths: () => DataPaths
  tools: Toolchain
  log: AppLogger
  definitions: readonly JobDefinition[]
  concurrency?: Partial<Record<ResourceClass, number>>
  progressIntervalMs?: number
  clock?: () => number
}

interface Entry {
  job: Job
  def: JobDefinition
  payload: unknown
  priority: number
  seq: number
  attempts: number
}

interface Running {
  entry: Entry
  ac: AbortController
  shutdown: boolean
  /** Aborted to free the slot for a more urgent job: requeue, don't cancel. */
  preempted: boolean
  /** Set when `stop()` gave up waiting; late settlement must not touch the store. */
  abandoned: boolean
  lastEmit: number
  lastProgress: number
  timer: ReturnType<typeof setTimeout> | undefined
  done: Promise<void>
}

export interface QueueStats {
  running: number
  queued: number
  limit: number
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error'

export class JobQueue {
  readonly #deps: QueueDeps
  readonly #defs = new Map<JobKind, JobDefinition>()
  readonly #limits: Record<ResourceClass, number>
  readonly #pending = new Map<ResourceClass, Entry[]>(CLASSES.map((c) => [c, []]))
  readonly #active = new Map<ResourceClass, number>(CLASSES.map((c) => [c, 0]))
  readonly #running = new Map<string, Running>()
  readonly #interval: number
  readonly #clock: () => number
  #started = false
  #stopped = false
  #pumpScheduled = false
  #idleWaiters: Array<() => void> = []

  constructor(deps: QueueDeps) {
    this.#deps = deps
    for (const def of deps.definitions) {
      if (this.#defs.has(def.kind)) throw new Error(`duplicate job definition: ${def.kind}`)
      this.#defs.set(def.kind, def)
    }
    this.#limits = { ...DEFAULT_CONCURRENCY, ...deps.concurrency }
    this.#interval = deps.progressIntervalMs ?? 200
    this.#clock = deps.clock ?? (() => performance.now())
  }

  /** Whether a handler is registered for `kind`. */
  has(kind: string): boolean {
    // Map#has accepts any key at runtime; the cast only widens the lookup type.
    return this.#defs.has(kind as JobKind)
  }

  get kinds(): JobKind[] {
    return [...this.#defs.keys()]
  }

  /** Creates, persists and schedules a job. Throws `UnknownJobKindError` for unregistered kinds. */
  enqueue<P>(kind: JobKind, payload: P, opts: EnqueueOptions = {}): Job {
    const def = this.#defs.get(kind)
    if (!def) throw new UnknownJobKindError(kind)
    const job: Job = {
      id: newId('j'),
      kind,
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.assetId ? { assetId: opts.assetId } : {}),
    }
    const priority = opts.priority ?? def.defaultPriority
    const seq = this.#deps.store.insertJob(job, payload, priority)
    this.#insert({ job, def, payload, priority, seq, attempts: 0 })
    this.#emit(job)
    this.#schedulePump()
    return job
  }

  /** Cancels a queued or running job. Returns the job, or undefined if unknown. */
  cancel(id: string): Job | undefined {
    const running = this.#running.get(id)
    if (running) {
      running.ac.abort(new Error('cancelled'))
      return running.entry.job
    }
    for (const list of this.#pending.values()) {
      const i = list.findIndex((e) => e.job.id === id)
      if (i < 0) continue
      const [entry] = list.splice(i, 1)
      this.#finish(entry!.job, 'cancelled')
      this.#notifyIdle()
      return entry!.job
    }
    return this.#deps.store.getJob(id)
  }

  /** Cancels every active job matching `predicate` (e.g. all jobs of a deleted asset). */
  cancelWhere(predicate: (job: Job) => boolean): number {
    const ids = [
      ...[...this.#running.values()].map((r) => r.entry.job),
      ...[...this.#pending.values()].flat().map((e) => e.job),
    ]
      .filter(predicate)
      .map((j) => j.id)
    for (const id of ids) this.cancel(id)
    return ids.length
  }

  /** Live view of an active job (fresher than the persisted copy between throttled writes). */
  active(id: string): Job | undefined {
    return (
      this.#running.get(id)?.entry.job ??
      [...this.#pending.values()].flat().find((e) => e.job.id === id)?.job
    )
  }

  /** Reloads persisted queued/running jobs after a restart. Call once before `start()`. */
  recover(): { queued: number; requeued: number; failed: number } {
    const { store } = this.#deps
    const out = { queued: 0, requeued: 0, failed: 0 }
    // Snapshot both sets first: requeueing a running job rewrites it as 'queued'.
    const queued = store.jobsWithStatus('queued')
    for (const rec of store.jobsWithStatus('running')) {
      const def = this.#defs.get(rec.job.kind)
      if (!def || rec.attempts >= MAX_INTERRUPTED_ATTEMPTS) {
        this.#finish(
          rec.job,
          'failed',
          def ? 'interrupted by a server restart twice' : `unsupported job kind: ${rec.job.kind}`,
        )
        out.failed++
        continue
      }
      const job: Job = { ...rec.job, status: 'queued', progress: 0 }
      delete job.startedAt
      delete job.eta
      job.message = 'Resuming after restart'
      store.putJob(job)
      this.#insert({ ...rec, job, def })
      out.requeued++
    }
    for (const rec of queued) {
      const def = this.#defs.get(rec.job.kind)
      if (!def) {
        this.#finish(rec.job, 'failed', `unsupported job kind: ${rec.job.kind}`)
        out.failed++
        continue
      }
      this.#insert({ ...rec, def })
      out.queued++
    }
    return out
  }

  /** Starts executing jobs. */
  start(): void {
    this.#started = true
    this.#schedulePump()
  }

  /**
   * Stops scheduling, aborts running jobs and persists them as `queued` (without counting the
   * attempt) so they resume on the next start. Resolves when handlers settled or after `timeoutMs`.
   */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.#stopped = true
    const running = [...this.#running.values()]
    for (const r of running) {
      r.shutdown = true
      r.ac.abort(new Error('server shutting down'))
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(running.map((r) => r.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    clearTimeout(timer)
    // Handlers that ignored the abort: persist them as resumable now and ignore whatever they
    // do later (the store may already be closed by then).
    for (const r of this.#running.values()) {
      this.#requeueForShutdown(r)
      r.abandoned = true
    }
  }

  stats(): Record<ResourceClass, QueueStats> {
    const out = {} as Record<ResourceClass, QueueStats>
    for (const c of CLASSES)
      out[c] = {
        running: this.#active.get(c)!,
        queued: this.#pending.get(c)!.length,
        limit: this.#limits[c],
      }
    return out
  }

  /** Resolves once nothing is queued or running (tests, graceful drains). */
  idle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve()
    return new Promise((resolve) => this.#idleWaiters.push(resolve))
  }

  /* ------------------------------------------------------------ internals */

  #isIdle(): boolean {
    return this.#running.size === 0 && [...this.#pending.values()].every((l) => l.length === 0)
  }

  #notifyIdle(): void {
    if (!this.#isIdle()) return
    const waiters = this.#idleWaiters
    this.#idleWaiters = []
    for (const w of waiters) w()
  }

  /** Sorted insert by (priority, seq) — binary search keeps it O(log n) + splice. */
  #insert(entry: Entry): void {
    const list = this.#pending.get(entry.def.resource)!
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const m = list[mid]!
      if (m.priority < entry.priority || (m.priority === entry.priority && m.seq < entry.seq))
        lo = mid + 1
      else hi = mid
    }
    list.splice(lo, 0, entry)
  }

  #schedulePump(): void {
    if (this.#pumpScheduled) return
    this.#pumpScheduled = true
    queueMicrotask(() => {
      this.#pumpScheduled = false
      this.#pump()
    })
  }

  #pump(): void {
    if (!this.#started || this.#stopped) return
    for (const c of CLASSES) {
      const list = this.#pending.get(c)!
      while (list.length > 0 && this.#active.get(c)! < this.#limits[c]) this.#run(list.shift()!)
      if (list.length > 0) this.#preemptFor(list[0]!)
    }
  }

  /** Asks the least urgent preemptible job of the class to yield to `waiting`, if any. */
  #preemptFor(waiting: Entry): void {
    let victim: Running | undefined
    for (const r of this.#running.values()) {
      const e = r.entry
      if (e.def.resource !== waiting.def.resource || !e.def.preemptible) continue
      if (r.preempted || r.shutdown || e.priority <= waiting.priority) continue
      if (!victim || e.priority > victim.entry.priority) victim = r
    }
    if (!victim) return
    victim.preempted = true
    this.#deps.log.info(
      { job: victim.entry.job.id, kind: victim.entry.job.kind, for: waiting.job.kind },
      'pausing background job for more urgent work',
    )
    victim.ac.abort(new Error('paused for more urgent work'))
  }

  /** Puts a preempted job back in the queue (same priority and sequence: it resumes first). */
  #requeuePreempted(r: Running): void {
    const { job } = r.entry
    job.status = 'queued'
    job.progress = 0
    job.message = 'Paused while the AI is busy with your edit'
    delete job.startedAt
    delete job.eta
    r.entry.attempts--
    this.#deps.store.setJobAttempts(job.id, r.entry.attempts)
    this.#persistAndEmit(job)
    this.#insert(r.entry)
  }

  /** Emits a snapshot: the live job object keeps mutating after the event was dispatched. */
  #emit(job: Job): void {
    this.#deps.bus.emit({ type: 'job', job: { ...job } })
  }

  #persistAndEmit(job: Job): void {
    this.#deps.store.putJob(job)
    this.#emit(job)
  }

  #finish(job: Job, status: 'done' | 'failed' | 'cancelled', error?: string): void {
    job.status = status
    job.finishedAt = new Date().toISOString()
    delete job.eta
    if (status === 'done') job.progress = 1
    if (error !== undefined) job.error = error
    this.#persistAndEmit(job)
  }

  #requeueForShutdown(r: Running): void {
    const { job } = r.entry
    clearTimeout(r.timer)
    job.status = 'queued'
    job.progress = 0
    delete job.startedAt
    delete job.eta
    this.#deps.store.putJob(job)
    this.#deps.store.setJobAttempts(job.id, r.entry.attempts - 1)
    this.#running.delete(job.id)
  }

  #run(entry: Entry): void {
    const { job, def } = entry
    const cls = def.resource
    this.#active.set(cls, this.#active.get(cls)! + 1)
    const r: Running = {
      entry,
      ac: new AbortController(),
      shutdown: false,
      preempted: false,
      abandoned: false,
      lastEmit: this.#clock(),
      lastProgress: 0,
      timer: undefined,
      done: Promise.resolve(),
    }
    this.#running.set(job.id, r)
    entry.attempts++
    job.status = 'running'
    job.progress = 0
    job.startedAt = new Date().toISOString()
    this.#deps.store.setJobAttempts(job.id, entry.attempts)
    this.#persistAndEmit(job)

    const flush = (): void => {
      clearTimeout(r.timer)
      r.timer = undefined
      if (job.status !== 'running') return
      r.lastEmit = this.#clock()
      r.lastProgress = job.progress
      this.#persistAndEmit(job)
    }
    const log = this.#deps.log.child({ job: job.id, kind: job.kind })
    const ctx: JobContext = {
      job,
      payload: entry.payload,
      signal: r.ac.signal,
      paths: this.#deps.paths(),
      tools: this.#deps.tools,
      store: this.#deps.store,
      log,
      progress: (p, message, eta) => {
        if (job.status !== 'running' || r.ac.signal.aborted) return
        job.progress = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : job.progress
        if (message !== undefined) job.message = message
        if (eta !== undefined && Number.isFinite(eta)) job.eta = Math.max(0, Math.round(eta))
        const now = this.#clock()
        const elapsed = now - r.lastEmit
        if (elapsed >= this.#interval || Math.abs(job.progress - r.lastProgress) >= 0.01) flush()
        else r.timer ??= setTimeout(flush, this.#interval - elapsed)
      },
      enqueue: (kind, payload, opts) => this.enqueue(kind, payload, opts),
      emit: (event) => this.#deps.bus.emit(event),
    }

    const started = this.#clock()
    r.done = (async () => {
      try {
        const result = await def.handler(ctx)
        if (r.ac.signal.aborted) throw r.ac.signal.reason
        clearTimeout(r.timer)
        if (result !== undefined) job.result = result
        delete job.message
        this.#finish(job, 'done')
        log.debug({ ms: Math.round(this.#clock() - started) }, 'job done')
      } catch (err) {
        clearTimeout(r.timer)
        if (r.abandoned) return
        if (r.shutdown) {
          this.#requeueForShutdown(r)
        } else if (r.preempted) {
          this.#requeuePreempted(r)
        } else if (r.ac.signal.aborted) {
          this.#finish(job, 'cancelled')
        } else {
          log.warn({ err }, 'job failed')
          this.#finish(job, 'failed', errorMessage(err))
        }
      } finally {
        this.#running.delete(job.id)
        this.#active.set(cls, this.#active.get(cls)! - 1)
        this.#schedulePump()
        this.#notifyIdle()
      }
    })()
  }
}
