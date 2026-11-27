/**
 * Shared onnxruntime session cache for the AI jobs. Sessions load lazily, are reused while
 * jobs keep coming, and are released after `IDLE_MS` without use so a model's weights do
 * not sit in the host's (iGPU-shared) RAM between edits. A failed creation never poisons
 * the cache, and DirectML falls back to the CPU provider.
 */
import os from 'node:os'
import * as ort from 'onnxruntime-node'

export type ExecutionProvider = 'cpu' | 'dml'

/** Release a session after this long without a `use` (ms). */
export const IDLE_MS = 60_000

export interface SessionOptions {
  provider: ExecutionProvider
  /** Intra-op threads (default: a quarter of the cores, leaving room for FFmpeg). */
  threads?: number
}

interface Entry {
  session: Promise<ort.InferenceSession>
  users: number
  timer: NodeJS.Timeout | undefined
}

const entries = new Map<string, Entry>()

const keyOf = (model: string, o: SessionOptions): string =>
  `${o.provider}\0${o.threads ?? 0}\0${model}`

const create = (model: string, o: SessionOptions): Promise<ort.InferenceSession> =>
  ort.InferenceSession.create(model, {
    executionProviders: [o.provider],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: o.threads ?? Math.max(1, Math.floor(os.availableParallelism() / 4)),
    interOpNumThreads: 1,
    // DirectML requires sequential execution and no memory pattern optimisation.
    ...(o.provider === 'dml' ? { executionMode: 'sequential', enableMemPattern: false } : {}),
  })

const release = (key: string): void => {
  const e = entries.get(key)
  if (!e || e.users > 0) return
  entries.delete(key)
  e.session.then(
    (s) => s.release(),
    () => undefined,
  )
}

/** Resolved provider: DirectML exists only on Windows. */
export const resolveProvider = (wanted: ExecutionProvider): ExecutionProvider =>
  wanted === 'dml' && process.platform !== 'win32' ? 'cpu' : wanted

/**
 * Borrow a session for the duration of `fn`. Falls back to the CPU provider when DirectML
 * cannot load. The idle timer starts when the last borrower returns.
 */
export const withSession = async <T>(
  model: string,
  o: SessionOptions,
  fn: (session: ort.InferenceSession, provider: ExecutionProvider) => Promise<T>,
): Promise<T> => {
  const provider = resolveProvider(o.provider)
  const opts = { ...o, provider }
  const key = keyOf(model, opts)
  let e = entries.get(key)
  if (!e) {
    const session = create(model, opts)
    e = { session, users: 0, timer: undefined }
    entries.set(key, e)
    session.catch(() => {
      if (entries.get(key)?.session === session) entries.delete(key)
    })
  }
  const entry = e
  entry.users++
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = undefined
  try {
    let session: ort.InferenceSession
    try {
      session = await entry.session
    } catch (err) {
      if (provider === 'cpu') throw err
      return await withSession(model, { ...o, provider: 'cpu' }, fn)
    }
    return await fn(session, provider)
  } finally {
    entry.users--
    if (entry.users === 0 && entries.get(key) === entry) {
      entry.timer = setTimeout(() => release(key), IDLE_MS)
      entry.timer.unref()
    }
  }
}

/** Release every idle session now (tests, shutdown). */
export const releaseIdleSessions = (): void => {
  for (const [key, e] of entries) {
    if (e.users > 0) continue
    if (e.timer) clearTimeout(e.timer)
    release(key)
  }
}

/** Number of cached sessions (tests). */
export const cachedSessionCount = (): number => entries.size
