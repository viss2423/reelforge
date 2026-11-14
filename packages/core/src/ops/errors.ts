/** Shared primitives for timeline operations. */
import type { Us } from '../schema.ts'

/** Thrown by every op on invalid input. `code` is stable and machine-readable. */
export class OpError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'OpError'
  }
}

/** Half-open time range [start, end) in µs. */
export interface Range {
  start: Us
  end: Us
}

/**
 * Deep copy of plain JSON model data. JSON round-tripping (rather than structuredClone) is
 * deliberate: it also works on Immer draft proxies, which structuredClone rejects.
 */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
