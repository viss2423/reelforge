import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sheet, resolveSnap } from '@/components/Sheet.tsx'

describe('resolveSnap', () => {
  const heights = [300, 600]
  it('settles on the nearest snap point', () => {
    expect(resolveSnap({ heights, current: 320, velocity: 0, dismissible: true })).toBe(0)
    expect(resolveSnap({ heights, current: 500, velocity: 0, dismissible: true })).toBe(1)
  })

  it('projects flick velocity (px/ms, + = down)', () => {
    // At 500 a fast downward flick lands on the lower snap, an upward one on the top.
    expect(resolveSnap({ heights, current: 500, velocity: 1.5, dismissible: true })).toBe(0)
    expect(resolveSnap({ heights, current: 350, velocity: -1.5, dismissible: true })).toBe(1)
  })

  it('dismisses below half the lowest snap only when dismissible', () => {
    expect(resolveSnap({ heights, current: 140, velocity: 0, dismissible: true })).toBe(-1)
    expect(resolveSnap({ heights, current: 300, velocity: 2, dismissible: true })).toBe(-1)
    expect(resolveSnap({ heights, current: 140, velocity: 0, dismissible: false })).toBe(0)
  })
})

const VH = 1000

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true })
})
afterEach(() => {
  vi.useRealTimers()
})

const panel = () => screen.getByRole('dialog')
const handle = () => screen.getByTestId('sheet-handle')
/** Runs the enter animation frame. */
const enter = () =>
  act(() => {
    vi.advanceTimersByTime(32)
  })
const translateY = () => Number(/translate3d\(0, (-?[\d.]+)px/.exec(panel().style.transform)?.[1])

const drag = (from: number, to: number, ms = 200) => {
  fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: from, timeStamp: 0 })
  const steps = 4
  for (let i = 1; i <= steps; i++) {
    fireEvent.pointerMove(handle(), {
      pointerId: 1,
      clientY: from + ((to - from) * i) / steps,
      timeStamp: (ms * i) / steps,
    })
  }
  fireEvent.pointerUp(handle(), { pointerId: 1 })
}

describe('Sheet', () => {
  it('renders a labelled dialog into the body and opens at the initial snap', () => {
    render(
      <Sheet open onClose={() => undefined} title="Text" snapPoints={[0.4, 0.9]}>
        <p>content</p>
      </Sheet>,
    )
    expect(panel().getAttribute('aria-label')).toBe('Text')
    expect(panel().getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText('content')).toBeTruthy()
    enter()
    // Panel is as tall as the highest snap (900) and translated so 400 px show.
    expect(panel().style.height).toBe('900px')
    expect(translateY()).toBe(500)
    expect(panel().dataset.snap).toBe('0')
  })

  it('drag up snaps to the taller point; drag down past half dismisses', () => {
    const onClose = vi.fn<() => void>()
    render(
      <Sheet open onClose={onClose} title="Panel" snapPoints={[0.4, 0.9]}>
        x
      </Sheet>,
    )
    enter()
    drag(600, 200, 800) // slow drag up by 400 px → 800 visible → nearest 900
    expect(panel().dataset.snap).toBe('1')
    expect(onClose).not.toHaveBeenCalled()
    drag(100, 900, 800) // down 800 px → 100 visible < 200 → dismiss
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('a quick downward flick dismisses even after a short distance', () => {
    const onClose = vi.fn<() => void>()
    render(
      <Sheet open onClose={onClose} title="Panel" snapPoints={[0.5]}>
        x
      </Sheet>,
    )
    enter()
    drag(500, 640, 40) // 140 px in 40 ms ≈ 3.5 px/ms
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('a swipe delivered before React renders the moves still dismisses', () => {
    // Fast swipes (and real phones under load) can send pointerup before React has rendered
    // the last pointermove; one act() batches the whole gesture into a single render.
    const onClose = vi.fn<() => void>()
    render(
      <Sheet open onClose={onClose} title="Panel" snapPoints={[0.9]}>
        x
      </Sheet>,
    )
    enter()
    act(() => drag(100, 990, 800))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('non-dismissible sheets spring back', () => {
    const onClose = vi.fn<() => void>()
    render(
      <Sheet open onClose={onClose} title="Busy" snapPoints={[0.5]} dismissible={false}>
        x
      </Sheet>,
    )
    enter()
    drag(500, 990, 50)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(translateY()).toBe(0)
  })

  it('rubber-bands when dragged above the tallest snap', () => {
    render(
      <Sheet open onClose={() => undefined} title="Panel" snapPoints={[0.5]}>
        x
      </Sheet>,
    )
    enter()
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 500, timeStamp: 0 })
    fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 300, timeStamp: 100 })
    // 200 px over the top → only 40 px of travel (20 %).
    expect(translateY()).toBe(-40)
  })

  it('Escape and the scrim close a modal sheet', () => {
    const onClose = vi.fn<() => void>()
    const { container } = render(
      <Sheet open onClose={onClose} title="Panel">
        x
      </Sheet>,
    )
    enter()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    const scrim = document.querySelector('[aria-hidden].bg-scrim')
    expect(scrim).toBeTruthy()
    fireEvent.click(scrim!)
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(container.innerHTML).toBe('') // portalled
  })

  it('non-modal sheets have no scrim and leave the page interactive', () => {
    render(
      <Sheet open onClose={() => undefined} title="Media" modal={false}>
        x
      </Sheet>,
    )
    expect(document.querySelector('.bg-scrim')).toBeNull()
    expect(panel().getAttribute('aria-modal')).toBe('false')
  })

  it('animates out, then unmounts; focus returns to the opener', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { rerender } = render(
      <Sheet open onClose={() => undefined} title="Panel">
        x
      </Sheet>,
    )
    enter()
    expect(document.activeElement).toBe(panel())
    rerender(
      <Sheet open={false} onClose={() => undefined} title="Panel">
        x
      </Sheet>,
    )
    expect(screen.queryByRole('dialog')).toBeTruthy() // exit animation running
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})

describe('Sheet closing', () => {
  it('lets taps through while it animates closed', () => {
    const { rerender } = render(
      <Sheet open onClose={() => undefined} title="Panel" modal={false}>
        x
      </Sheet>,
    )
    act(() => {
      vi.advanceTimersByTime(32)
    })
    expect(screen.getByRole('dialog').className).toContain('pointer-events-auto')
    rerender(
      <Sheet open={false} onClose={() => undefined} title="Panel" modal={false}>
        x
      </Sheet>,
    )
    expect(screen.getByRole('dialog').className).toContain('pointer-events-none')
    expect(screen.getByRole('dialog').className).not.toContain('pointer-events-auto')
  })
})
