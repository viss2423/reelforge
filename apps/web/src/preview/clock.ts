/**
 * Playback clock.
 *
 * During playback the MASTER clock is the audio hardware (AudioContext output timestamp), so
 * picture follows sound and never drifts from it. The audio clock, however, advances in
 * coarse steps on some browsers (Safari/Firefox update `currentTime` per 10–40 ms render
 * chunk) and its relationship to `performance.now()` can jitter. Driving frames from it
 * directly makes motion stutter, so this clock *predicts* time from the high-resolution
 * frame clock and slews towards the master:
 *
 *   predicted += Δperf · rate
 *   error = master − predicted
 *   |error| > HARD_RESYNC → snap (seek, device change, long stall)
 *   otherwise            → predicted += error · SLEW (exponential convergence, ~10 frames)
 *
 * After start/seek/resume the first sample is only heard once the master reaches the anchor
 * (scheduling lead + output latency, ~50–150 ms); until then the picture HOLDS on the start
 * frame instead of running ahead and snapping back, so every resume is seamless.
 *
 * The output is monotonic (never runs backwards while playing) except on a hard resync.
 * Without a master (no audio / AudioContext locked) it is a plain performance clock.
 */

/** Errors above this (us) snap instead of slewing. */
export const HARD_RESYNC_US = 80_000
/** Fraction of the remaining error corrected per tick. */
export const SLEW = 0.12

export class PlaybackClock {
  #playing = false
  /** Timeline time (us, float) at the last tick. */
  #t = 0
  #lastPerf = 0
  /** Master anchor: timeline time at `#masterAnchor` seconds of the master clock. */
  #masterAnchorT = 0
  #masterAnchor = Number.NaN
  /** True until the master first reaches the anchor (start frame not yet audible). */
  #holding = false
  rate = 1

  get playing(): boolean {
    return this.#playing
  }

  /** Current (last computed) timeline time in us, rounded to an integer. */
  get time(): number {
    return Math.round(this.#t)
  }

  /** Jump to `t` (us). Keeps the playing state; re-anchors the master. */
  seek(t: number, perfNow: number, masterNow?: number): void {
    this.#t = t
    this.#lastPerf = perfNow
    this.#anchor(t, masterNow)
  }

  start(t: number, perfNow: number, masterNow?: number): void {
    this.#playing = true
    this.seek(t, perfNow, masterNow)
  }

  /** Stop at the current time and return it. */
  stop(): number {
    this.#playing = false
    return this.time
  }

  /** (Re)attach the master clock without moving the timeline (e.g. audio became unlocked). */
  attachMaster(masterNow: number | undefined): void {
    this.#anchor(this.#t, masterNow)
  }

  #anchor(t: number, masterNow: number | undefined): void {
    this.#masterAnchorT = t
    this.#masterAnchor = masterNow ?? Number.NaN
    this.#holding = masterNow !== undefined
  }

  /**
   * Advance to the frame at `perfNow` (ms, performance.now / rAF timestamp). `masterNow` is
   * the master clock in seconds (audio output time) or undefined when there is none.
   * Returns the timeline time (us, integer).
   */
  tick(perfNow: number, masterNow?: number): number {
    if (!this.#playing) {
      this.#lastPerf = perfNow
      return this.time
    }
    const dPerf = Math.max(0, perfNow - this.#lastPerf)
    this.#lastPerf = perfNow
    let t = this.#t + dPerf * 1000 * this.rate
    if (masterNow !== undefined && !Number.isNaN(this.#masterAnchor)) {
      if (masterNow < this.#masterAnchor) {
        // sound not audible yet: hold the start frame (it is what will be heard first)
        this.#t = this.#masterAnchorT
        return this.time
      }
      const master = this.#masterAnchorT + (masterNow - this.#masterAnchor) * 1e6 * this.rate
      const err = master - t
      if (this.#holding) {
        // first audible tick: lock onto the master (the prediction ran during the hold)
        this.#holding = false
        t = master
      } else if (Math.abs(err) > HARD_RESYNC_US) t = master
      else if (err > 0) t += err * SLEW
      else t = Math.max(this.#t, t + err * SLEW) // slow down but never go backwards
    } else if (masterNow !== undefined) {
      this.#anchor(t, masterNow)
    }
    this.#t = t
    return this.time
  }
}

/**
 * Map a performance.now() timestamp to the AudioContext time being HEARD at that instant,
 * using `getOutputTimestamp()` (accounts for output latency) with a latency-corrected
 * `currentTime` fallback. Returns undefined when the context is not running.
 */
export function audioOutputTime(ctx: AudioContext, perfNow: number): number | undefined {
  if (ctx.state !== 'running') return undefined
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : undefined
  if (
    ts &&
    ts.contextTime !== undefined &&
    ts.performanceTime !== undefined &&
    ts.performanceTime > 0
  ) {
    return ts.contextTime + (perfNow - ts.performanceTime) / 1000
  }
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0)
}
