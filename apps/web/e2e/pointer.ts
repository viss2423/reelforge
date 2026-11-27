/**
 * Pointer input for timeline gestures, shared by the mocked and real-server specs.
 */
import type { Page } from '@playwright/test'

/**
 * Pointer input that works the same in every engine: real mouse events on desktop, and
 * synthetic touch PointerEvents on phones (Playwright has no multi-touch drag API).
 */
export const pointer = (page: Page, touch: boolean, testId = 'timeline-viewport') => {
  const vp = page.getByTestId(testId)
  const fire = (type: string, x: number, y: number, id = 1) =>
    vp.dispatchEvent(type, {
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    })
  return {
    down: (x: number, y: number, id = 1) =>
      touch ? fire('pointerdown', x, y, id) : page.mouse.move(x, y).then(() => page.mouse.down()),
    move: async (x: number, y: number, id = 1, steps = 8) => {
      if (!touch) return page.mouse.move(x, y, { steps })
      await fire('pointermove', x, y, id)
    },
    up: (x: number, y: number, id = 1) =>
      touch ? fire('pointerup', x, y, id) : page.mouse.move(x, y).then(() => page.mouse.up()),
    /** Drag in small steps (touch moves are interpolated by hand). */
    drag: async (from: [number, number], to: [number, number], opts: { hold?: number } = {}) => {
      const p = pointer(page, touch, testId)
      await p.down(...from)
      if (opts.hold) await page.waitForTimeout(opts.hold)
      const steps = 10
      for (let i = 1; i <= steps; i++) {
        const x = from[0] + ((to[0] - from[0]) * i) / steps
        const y = from[1] + ((to[1] - from[1]) * i) / steps
        if (touch) await fire('pointermove', x, y)
        else await page.mouse.move(x, y)
      }
      await p.up(...to)
    },
    tap: async (x: number, y: number) => {
      const p = pointer(page, touch, testId)
      await p.down(x, y)
      await p.up(x, y)
    },
  }
}

/** Phones and tablets drive the timeline with touch. */
export const isTouch = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024
