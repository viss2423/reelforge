/**
 * Adaptive render resolution.
 *
 * The compositor renders into a backing store of `renderSize()` pixels and the browser
 * scales it to the canvas' CSS size. 'high' renders at device resolution (capped at the
 * 1080×1920 canvas), 'low' at proxy resolution (540 wide), and 'auto' starts at device
 * resolution and steps down a level whenever the measured GPU+CPU frame cost exceeds the
 * frame budget, stepping back up after a sustained period of headroom (hysteresis prevents
 * oscillation). Pure logic — the engine feeds it frame costs.
 */
import { CANVAS_H, CANVAS_W } from './timeline/layers.ts'

export type QualityMode = 'auto' | 'low' | 'high'

/** Scale levels relative to the 'high' size. */
export const LEVELS = [1, 0.85, 0.7, 0.55, 0.42] as const
/** Proxy width: 'low' never renders wider than the proxies themselves. */
export const LOW_WIDTH = 540

const DOWN_WINDOW = 20
const UP_WINDOW = 180

export class AdaptiveQuality {
  mode: QualityMode = 'auto'
  #level = 0
  #budget = 1000 / 60
  #over = 0
  #under = 0
  #avg = 0

  /** Current level index into {@link LEVELS} (auto mode). */
  get level(): number {
    return this.#level
  }

  /** Exponential moving average of frame cost (ms). */
  get averageCost(): number {
    return this.#avg
  }

  setMode(mode: QualityMode): void {
    this.mode = mode
    this.#level = 0
    this.#over = 0
    this.#under = 0
  }

  /** Frame budget in ms (from the display refresh rate). */
  setBudget(ms: number): void {
    this.#budget = Math.max(4, ms)
  }

  /**
   * Record one frame's cost (ms of compositor work). Returns true when the render size
   * changed as a result.
   */
  record(costMs: number): boolean {
    this.#avg = this.#avg === 0 ? costMs : this.#avg * 0.9 + costMs * 0.1
    if (this.mode !== 'auto') return false
    // leave headroom for the browser's own compositing and JASSUB
    const high = this.#budget * 0.75
    const low = this.#budget * 0.35
    if (this.#avg > high) {
      this.#under = 0
      if (++this.#over >= DOWN_WINDOW && this.#level < LEVELS.length - 1) {
        this.#level++
        this.#over = 0
        this.#avg = 0
        return true
      }
    } else if (this.#avg < low) {
      this.#over = 0
      if (++this.#under >= UP_WINDOW && this.#level > 0) {
        this.#level--
        this.#under = 0
        this.#avg = 0
        return true
      }
    } else {
      this.#over = 0
      this.#under = 0
    }
    return false
  }

  /**
   * Backing-store size for a canvas of `cssW`×`cssH` CSS px at device pixel ratio `dpr`.
   * Always 9:16 and even (video-friendly), never larger than the 1080×1920 canvas.
   */
  renderSize(cssW: number, cssH: number, dpr: number): { width: number; height: number } {
    // the drawn picture is the largest 9:16 rect inside the element
    const fitW = Math.min(cssW, (cssH * CANVAS_W) / CANVAS_H)
    let w = Math.min(CANVAS_W, Math.max(2, fitW * Math.max(1, dpr)))
    if (this.mode === 'low') w = Math.min(w, LOW_WIDTH)
    else if (this.mode === 'auto') w *= LEVELS[this.#level]!
    const width = Math.max(2, Math.round(w / 2) * 2)
    const height = Math.max(2, Math.round((width * CANVAS_H) / CANVAS_W / 2) * 2)
    return { width, height }
  }
}
