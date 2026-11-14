/** Exponential backoff with full jitter (AWS-style): uniform in [base, min(max, base·2^attempt)]. */
export const backoffDelay = (
  attempt: number,
  {
    base = 500,
    max = 30_000,
    random = Math.random,
  }: { base?: number; max?: number; random?: () => number } = {},
): number => {
  const ceil = Math.min(max, base * 2 ** Math.max(0, attempt))
  return Math.round(base + (ceil - base) * random())
}

/** Promise-based sleep that rejects with the signal's reason when aborted. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason as Error)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** True for errors produced by aborting a fetch/XHR/sleep. */
export const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError'
