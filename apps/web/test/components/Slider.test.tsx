import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  Slider,
  applyDetent,
  precisionScale,
  quantize,
  type SliderProps,
} from '@/components/Slider.tsx'

describe('pure helpers', () => {
  it('quantize clamps and snaps to the step grid without float noise', () => {
    expect(quantize(0.30000000000000004, 0, 1, 0.1)).toBe(0.3)
    expect(quantize(7, 0, 10, 5)).toBe(5)
    expect(quantize(8, 0, 10, 5)).toBe(10)
    expect(quantize(-3, -2, 2, 0.5)).toBe(-2)
    expect(quantize(1.26, 1, 2, 0.25)).toBe(1.25)
    expect(quantize(Number.NaN, 3, 9, 1)).toBe(3)
  })

  it('precisionScale slows down as the finger moves away from the track', () => {
    expect(precisionScale(0)).toBe(1)
    expect(precisionScale(24)).toBe(1)
    expect(precisionScale(-72)).toBe(0.5)
    expect(precisionScale(24 + 48 * 3)).toBe(0.25)
  })

  it('applyDetent snaps near the default only', () => {
    expect(applyDetent(1.4, 0, -100, 100)).toBe(0)
    expect(applyDetent(3.1, 0, -100, 100)).toBe(3.1)
    expect(applyDetent(3.1, undefined, -100, 100)).toBe(3.1)
  })
})

/** Controlled harness that records callbacks. */
function Harness(props: Partial<SliderProps> & { initial?: number; log: string[] }) {
  const { initial = 50, log, ...rest } = props
  const [v, setV] = useState(initial)
  return (
    <Slider
      label="Opacity"
      min={0}
      max={100}
      value={v}
      onChange={(n) => {
        log.push(`change:${n}`)
        setV(n)
      }}
      onChangeStart={() => log.push('start')}
      onChangeEnd={(n) => log.push(`end:${n}`)}
      {...rest}
    />
  )
}

const TRACK_WIDTH = 200
let vibrate: Mock<Navigator['vibrate']>

beforeEach(() => {
  // Track geometry: 200 px wide at x=0 (happy-dom has no layout).
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: TRACK_WIDTH,
    height: 6,
    right: TRACK_WIDTH,
    bottom: 6,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  vibrate = vi.fn<Navigator['vibrate']>(() => true)
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
})
afterEach(() => {
  Reflect.deleteProperty(navigator, 'vibrate')
})

const thumb = () => screen.getByRole('slider')
const surface = () => thumb().parentElement!

describe('Slider', () => {
  it('exposes slider semantics', () => {
    render(<Harness log={[]} unit="%" />)
    expect(thumb().getAttribute('aria-valuenow')).toBe('50')
    expect(thumb().getAttribute('aria-valuemin')).toBe('0')
    expect(thumb().getAttribute('aria-valuemax')).toBe('100')
    expect(thumb().getAttribute('aria-valuetext')).toBe('50%')
    expect(screen.getByText('Opacity')).toBeTruthy()
  })

  it('keyboard: arrows, shift for big steps, Home/End; one gesture per key', () => {
    const log: string[] = []
    render(<Harness log={log} />)
    fireEvent.keyDown(thumb(), { key: 'ArrowRight' })
    fireEvent.keyDown(thumb(), { key: 'ArrowUp', shiftKey: true })
    fireEvent.keyDown(thumb(), { key: 'ArrowLeft' })
    expect(log).toEqual([
      'start',
      'change:51',
      'end:51',
      'start',
      'change:61',
      'end:61',
      'start',
      'change:60',
      'end:60',
    ])
    fireEvent.keyDown(thumb(), { key: 'End' })
    expect(thumb().getAttribute('aria-valuenow')).toBe('100')
    fireEvent.keyDown(thumb(), { key: 'PageUp' }) // clamped: no change emitted
    expect(log.slice(-2)).toEqual(['start', 'end:100'])
    fireEvent.keyDown(thumb(), { key: 'Home' })
    expect(thumb().getAttribute('aria-valuenow')).toBe('0')
  })

  it('tapping the track jumps to that position', () => {
    const log: string[] = []
    render(<Harness log={log} />)
    fireEvent.pointerDown(surface(), { button: 0, pointerId: 1, clientX: 50, clientY: 0 })
    fireEvent.pointerUp(surface(), { pointerId: 1 })
    expect(log).toEqual(['start', 'change:25', 'end:25'])
  })

  it('dragging the thumb is relative (no jump) and ends with the last value', () => {
    const log: string[] = []
    render(<Harness log={log} />)
    fireEvent.pointerDown(thumb(), { button: 0, pointerId: 1, clientX: 100, clientY: 0 })
    fireEvent.pointerMove(surface(), { pointerId: 1, clientX: 120, clientY: 0 })
    fireEvent.pointerMove(surface(), { pointerId: 1, clientX: 140, clientY: 0 })
    fireEvent.pointerUp(surface(), { pointerId: 1 })
    expect(log).toEqual(['start', 'change:60', 'change:70', 'end:70'])
  })

  it('moving the finger away from the track enables fine scrubbing', () => {
    const log: string[] = []
    render(<Harness log={log} step={0.5} />)
    fireEvent.pointerDown(thumb(), { button: 0, pointerId: 1, clientX: 100, clientY: 0 })
    // 72 px below the track → half speed: 20 px = 5 units instead of 10.
    fireEvent.pointerMove(surface(), { pointerId: 1, clientX: 120, clientY: 72 })
    expect(log.at(-1)).toBe('change:55')
  })

  it('snaps magnetically to the default while dragging', () => {
    const log: string[] = []
    render(<Harness log={log} initial={40} defaultValue={50} step={0.1} />)
    fireEvent.pointerDown(thumb(), { button: 0, pointerId: 1, clientX: 80, clientY: 0 })
    fireEvent.pointerMove(surface(), { pointerId: 1, clientX: 99, clientY: 0 }) // 49.5 → detent
    expect(log.at(-1)).toBe('change:50')
    expect(vibrate).toHaveBeenCalledWith(10)
  })

  it('double-tap resets to the default', () => {
    const log: string[] = []
    render(<Harness log={log} initial={80} defaultValue={50} />)
    fireEvent.pointerDown(thumb(), { button: 0, pointerId: 1, clientX: 160 })
    fireEvent.pointerUp(surface(), { pointerId: 1 })
    fireEvent.pointerDown(thumb(), { button: 0, pointerId: 1, clientX: 160 })
    expect(log.slice(-3)).toEqual(['start', 'change:50', 'end:50'])
    expect(thumb().getAttribute('aria-valuenow')).toBe('50')
  })

  it('vibrates when hitting a limit', () => {
    render(<Harness log={[]} initial={99} />)
    fireEvent.keyDown(thumb(), { key: 'ArrowRight' })
    expect(vibrate).toHaveBeenCalledWith(8)
  })

  it('numeric entry: tap the value, type, Enter (quantized and clamped)', () => {
    const log: string[] = []
    render(<Harness log={log} step={0.5} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Opacity value' }))
    const input = screen.getByLabelText('Opacity value')
    fireEvent.change(input, { target: { value: '42,7' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(log).toEqual(['start', 'change:42.5', 'end:42.5'])
    fireEvent.click(screen.getByRole('button', { name: 'Edit Opacity value' }))
    const again = screen.getByLabelText('Opacity value')
    fireEvent.change(again, { target: { value: '500' } })
    act(() => again.blur())
    expect(log.at(-1)).toBe('end:100')
  })

  it('numeric entry ignores garbage and Escape cancels', () => {
    const log: string[] = []
    render(<Harness log={log} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Opacity value' }))
    const input = screen.getByLabelText('Opacity value')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(log).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Edit Opacity value' }))
    fireEvent.keyDown(screen.getByLabelText('Opacity value'), { key: 'Escape' })
    expect(screen.queryByLabelText('Opacity value')).toBeNull()
  })

  it('does nothing when disabled', () => {
    const log: string[] = []
    render(<Harness log={log} disabled />)
    fireEvent.keyDown(thumb(), { key: 'ArrowRight' })
    fireEvent.pointerDown(surface(), { button: 0, pointerId: 1, clientX: 10 })
    expect(log).toEqual([])
    expect(thumb().getAttribute('tabindex')).toBe('-1')
  })

  it('uses a custom formatter for the value', () => {
    render(<Harness log={[]} format={(v) => `${v / 100}×`} />)
    expect(screen.getByRole('button', { name: 'Edit Opacity value' }).textContent).toBe('0.5×')
  })
})
