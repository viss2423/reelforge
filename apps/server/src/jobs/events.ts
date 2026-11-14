/**
 * In-process pub/sub for `ServerEvent`s (jobs, assets, projects, packs). Delivery is
 * synchronous and listeners must be cheap (the WebSocket layer only enqueues); a throwing
 * listener is isolated so it can never break the emitter (e.g. a job's progress update).
 */
import type { ServerEvent } from '@reelforge/core'

export type EventListener = (event: ServerEvent) => void

export class EventBus {
  readonly #listeners = new Set<EventListener>()
  readonly #onError: (err: unknown) => void

  constructor(onError: (err: unknown) => void = () => {}) {
    this.#onError = onError
  }

  /** Subscribes; returns the unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit(event: ServerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (err) {
        this.#onError(err)
      }
    }
  }

  get size(): number {
    return this.#listeners.size
  }
}
