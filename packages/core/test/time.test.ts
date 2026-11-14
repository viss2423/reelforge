import { describe, expect, it } from 'vitest'
import {
  ffTime,
  formatTimecode,
  frameDuration,
  fromFrame,
  ms,
  sec,
  snapToFrame,
  toFrame,
  toSeconds,
} from '../src/index.ts'

describe('time helpers', () => {
  it('converts seconds and milliseconds to integer µs', () => {
    expect(sec(1.5)).toBe(1_500_000)
    expect(sec(1 / 3)).toBe(333_333)
    expect(ms(2.5)).toBe(2_500)
    expect(toSeconds(2_250_000)).toBe(2.25)
  })

  it('frame maths round-trips at integer and fractional rates', () => {
    expect(frameDuration(25)).toBe(40_000)
    expect(frameDuration(30)).toBeCloseTo(33_333.333, 3)
    expect(toFrame(1_000_000, 30)).toBe(30)
    expect(fromFrame(30, 30)).toBe(1_000_000)
    expect(fromFrame(1, 30)).toBe(33_333)
    for (let f = 0; f < 200; f++) expect(toFrame(fromFrame(f, 30000 / 1001), 30000 / 1001)).toBe(f)
  })

  it('snaps to the nearest frame boundary', () => {
    expect(snapToFrame(1_010_000, 25)).toBe(1_000_000)
    expect(snapToFrame(1_030_000, 25)).toBe(1_040_000)
    expect(snapToFrame(50_000, 30)).toBe(66_667)
  })

  it('formats timecodes with and without centiseconds, including negatives', () => {
    expect(formatTimecode(62_350_000)).toBe('1:02.35')
    expect(formatTimecode(62_359_999, false)).toBe('1:02')
    expect(formatTimecode(-5_000_000)).toBe('-0:05.00')
    expect(formatTimecode(0)).toBe('0:00.00')
  })

  it('prints FFmpeg seconds with µs precision', () => {
    expect(ffTime(1_234_567)).toBe('1.234567')
    expect(ffTime(0)).toBe('0.000000')
  })
})
