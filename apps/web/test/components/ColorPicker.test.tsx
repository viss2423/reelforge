import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ColorPicker, pushRecentColor, readRecentColors } from '@/components/ColorPicker.tsx'
import { hexToRgba, hsvToHex, normalizeHex, rgbToHsv, rgbaToHex } from '@/lib/color.ts'

describe('colour maths', () => {
  it('normalizeHex accepts short/long forms and canonicalises', () => {
    expect(normalizeHex('fff')).toBe('#FFFFFF')
    expect(normalizeHex('#abcd')).toBe('#AABBCCDD')
    expect(normalizeHex(' #12ab34 ')).toBe('#12AB34')
    expect(normalizeHex('#112233ff')).toBe('#112233')
    expect(normalizeHex('#12345')).toBeUndefined()
    expect(normalizeHex('zzzzzz')).toBeUndefined()
  })

  it('hex ↔ rgba ↔ hsv round-trips', () => {
    expect(hexToRgba('#FF000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 })
    expect(rgbaToHex({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#FF000080')
    for (const hex of ['#FF2D7A', '#00E5FF', '#39FF14', '#000000', '#FFFFFF', '#808080']) {
      expect(hsvToHex(rgbToHsv(hexToRgba(hex)))).toBe(hex)
    }
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 1, v: 1 })
  })
})

describe('recent colours', () => {
  it('keeps unique, most-recent-first, capped at 12', () => {
    for (let i = 0; i < 15; i++) pushRecentColor(`#0000${String(i).padStart(2, '0')}`)
    pushRecentColor('#000003')
    const list = readRecentColors()
    expect(list).toHaveLength(12)
    expect(list[0]).toBe('#000003')
    expect(new Set(list).size).toBe(12)
  })

  it('survives corrupt storage', () => {
    localStorage.setItem('rf.recentColors', '{oops')
    expect(readRecentColors()).toEqual([])
  })
})

function Harness({ alpha = false, log }: { alpha?: boolean; log: string[] }) {
  const [v, setV] = useState('#FF0000')
  return (
    <ColorPicker
      label="Text colour"
      value={v}
      alpha={alpha}
      onChange={(hex) => {
        log.push(`change:${hex}`)
        setV(hex)
      }}
      onChangeStart={() => log.push('start')}
      onChangeEnd={(hex) => log.push(`end:${hex}`)}
    />
  )
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
})

describe('ColorPicker', () => {
  it('picks a swatch as one gesture and records it as recent', () => {
    const log: string[] = []
    render(<Harness log={log} />)
    fireEvent.click(screen.getByRole('button', { name: 'Use colour #FFE400' }))
    expect(log).toEqual(['start', 'change:#FFE400', 'end:#FFE400'])
    expect(readRecentColors()[0]).toBe('#FFE400')
    expect(screen.getByTestId('recent-colors')).toBeTruthy()
    expect(
      screen
        .getAllByRole('button', { name: 'Use colour #FFE400' })[0]
        ?.getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('accepts typed hex on Enter and ignores invalid input', () => {
    const log: string[] = []
    render(<Harness log={log} />)
    const input = screen.getByLabelText('Hex colour')
    fireEvent.change(input, { target: { value: '0f0' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(log).toEqual(['start', 'change:#00FF00', 'end:#00FF00'])
    fireEvent.change(input, { target: { value: 'nope' } })
    expect(input.className).toContain('border-danger')
    fireEvent.blur(input)
    expect(log).toHaveLength(3)
    expect((input as HTMLInputElement).value).toBe('#00FF00')
  })

  it('drags the saturation/brightness area', () => {
    const log: string[] = []
    render(<Harness log={log} />)
    const area = screen.getByLabelText('Saturation and brightness')
    fireEvent.pointerDown(area, { button: 0, pointerId: 1, clientX: 100, clientY: 50 })
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 0, clientY: 50 })
    fireEvent.pointerUp(area, { pointerId: 1 })
    // Full saturation at half brightness, then zero saturation (grey) — hue is preserved.
    expect(log).toEqual(['start', 'change:#800000', 'change:#808080', 'end:#808080'])
    // Dragging back keeps the original hue even though grey has none.
    fireEvent.pointerDown(area, { button: 0, pointerId: 1, clientX: 100, clientY: 0 })
    fireEvent.pointerUp(area, { pointerId: 1 })
    expect(log.at(-1)).toBe('end:#FF0000')
  })

  it('drags the hue bar', () => {
    const log: string[] = []
    render(<Harness log={log} />)
    const hue = screen.getByLabelText('Hue')
    fireEvent.pointerDown(hue, { button: 0, pointerId: 1, clientX: 50, clientY: 0 })
    fireEvent.pointerUp(hue, { pointerId: 1 })
    expect(log).toEqual(['start', 'change:#00FFFF', 'end:#00FFFF'])
  })

  it('emits 8-digit hex from the opacity bar when alpha is enabled', () => {
    const log: string[] = []
    render(<Harness log={log} alpha />)
    const bar = screen.getByLabelText('Opacity')
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 50, clientY: 0 })
    fireEvent.pointerUp(bar, { pointerId: 1 })
    expect(log).toEqual(['start', 'change:#FF000080', 'end:#FF000080'])
  })

  it('has no opacity bar without alpha', () => {
    render(<Harness log={[]} />)
    expect(screen.queryByLabelText('Opacity')).toBeNull()
  })
})
