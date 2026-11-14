/**
 * Kinetic scrolling: a pointer velocity tracker and an exponential-decay fling (the iOS
 * scroll-view model: velocity decays with a ~325 ms time constant, so the total travel is
 * v × τ). Time is injected so the maths is testable without real frames.
 */

/** Velocity samples older than this are ignored (a pause before release stops the fling). */
const WINDOW_MS = 100
/** Fling decay time constant. */
export const FLING_TIME_CONSTANT = 325
/** Below this speed (px/ms) a fling stops. */
export const FLING_MIN_SPEED = 0.02
/** Flings are capped so a wild swipe can't throw the timeline to the far end. */
const MAX_SPEED = 8

const cap = (v: number): number => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v))

interface Sample {
  t: number
  x: number
  y: number
}

export class VelocityTracker {
  #samples: Sample[] = []

  reset(): void {
    this.#samples.length = 0
  }

  add(t: number, x: number, y: number): void {
    this.#samples.push({ t, x, y })
    // Keep the buffer tiny: drop samples that fell out of the window.
    while (this.#samples.length > 2 && t - this.#samples[0]!.t > WINDOW_MS) this.#samples.shift()
  }

  /** Velocity in px/ms over the recent window (0 if the pointer rested). */
  velocity(now: number): { vx: number; vy: number } {
    const recent = this.#samples.filter((s) => now - s.t <= WINDOW_MS)
    if (recent.length < 2) return { vx: 0, vy: 0 }
    const a = recent[0]!
    const b = recent[recent.length - 1]!
    const dt = b.t - a.t
    if (dt <= 0) return { vx: 0, vy: 0 }
    return { vx: cap((b.x - a.x) / dt), vy: cap((b.y - a.y) / dt) }
  }
}

/**
 * Advances a fling by `dt` ms. Returns the displacement over that interval (exact integral
 * of the decaying velocity, so it is frame-rate independent) and the new velocity.
 */
export const flingStep = (
  v: number,
  dt: number,
  tau = FLING_TIME_CONSTANT,
): { dx: number; v: number } => {
  const decay = Math.exp(-dt / tau)
  return { dx: v * tau * (1 - decay), v: v * decay }
}

/** Total distance a fling with initial velocity `v` (px/ms) travels. */
export const flingDistance = (v: number, tau = FLING_TIME_CONSTANT): number => v * tau
