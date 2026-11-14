/**
 * Opt-in Performance API instrumentation for the timeline hot paths. Disabled (one global
 * read) unless `globalThis.__RF_PERF__ === true`, which the perf e2e spec sets before load.
 * Measures show up in DevTools → Performance → Timings and in
 * `performance.getEntriesByType('measure')`.
 */
declare global {
  var __RF_PERF__: boolean | undefined
}

export const perfEnabled = (): boolean => globalThis.__RF_PERF__ === true

/** Start timestamp, or 0 when instrumentation is off. */
export const perfStart = (): number => (perfEnabled() ? performance.now() : 0)

/** Records `name` from `start` (a `perfStart()` value) to now. */
export const perfEnd = (name: string, start: number): void => {
  if (start) performance.measure(name, { start, end: performance.now() })
}
