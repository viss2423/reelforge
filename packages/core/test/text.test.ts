import { describe, expect, it } from 'vitest'
import { displayTitle } from '../src/text.ts'

describe('displayTitle', () => {
  it.each([
    ['smu vs lsu', 'SMU vs LSU'],
    ['lsu basketball', 'LSU Basketball'],
    ['lowes black friday deals', 'Lowes Black Friday Deals'],
    ["don't stop believin'", "Don't Stop Believin'"],
    ['the lord of the rings', 'The Lord of the Rings'],
    ['spider-man trailer', 'Spider-Man Trailer'],
    ['gta6 release date', 'GTA6 Release Date'],
    ['ps5 pro 4k test', 'PS5 Pro 4K Test'],
    ['iphone 18 vs galaxy s26', 'iPhone 18 vs Galaxy S26'],
    ['nfl week 13', 'NFL Week 13'],
    ['  miss   universe 2026 ', 'Miss Universe 2026'],
    ['ramayana part 1', 'Ramayana Part 1'],
    ['día de muertos', 'Día de Muertos'],
  ])('%s → %s', (input, out) => {
    expect(displayTitle(input)).toBe(out)
  })

  it('keeps text that already has real casing', () => {
    expect(displayTitle('APT. by ROSÉ')).toBe('APT. by ROSÉ')
    expect(displayTitle('Taylor Swift')).toBe('Taylor Swift')
  })
})
