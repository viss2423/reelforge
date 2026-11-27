import { PackManifest } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import type { Packs } from '@/api/schemas.ts'
import { templateLook } from '@/screens/home/templateLook.ts'
import { shortAgo, vibeForSound } from '@/screens/TrendingScreen.tsx'

const manifest = PackManifest.parse({
  id: 'p',
  version: '1.0.0',
  name: 'P',
  curatedAt: '2026-11-01',
  textPresets: [
    {
      id: 'hook',
      name: 'Hook',
      style: { fontFamily: 'Anton', color: '#FFE400', uppercase: true },
    },
  ],
  templates: [
    {
      id: 'snow',
      name: 'Snow Day Dump',
      tags: ['winter'],
      slots: [
        { duration: 1_000_000, text: { text: 'Snow day!', preset: 'p/hook' } },
        { duration: 1 },
      ],
    },
    { id: 'plain', name: 'Plain', slots: [{ duration: 1_000_000 }] },
  ],
})
const packs: Packs = {
  index: { version: '1', updatedAt: '2026-11-01', minAppVersion: '0.1.0', packs: [], fonts: [] },
  manifests: [manifest],
}

describe('templateLook', () => {
  it("uses the template's own hook text and text preset", () => {
    const look = templateLook(manifest.templates[0]!, packs)
    expect(look.hook).toBe('Snow day!')
    expect(look.style?.fontFamily).toBe('Anton')
    // Winter palette, with the hook colour glowing over it.
    expect(look.background).toContain('#16306e')
    expect(look.background).toContain('#FFE400')
  })

  it('falls back to the name and a stable gradient', () => {
    const a = templateLook(manifest.templates[1]!, packs)
    expect(a.hook).toBe('Plain')
    expect(a.style).toBeUndefined()
    expect(templateLook(manifest.templates[1]!, packs).background).toBe(a.background)
  })
})

describe('Trending helpers', () => {
  const now = Date.parse('2026-11-27T12:00:00Z')
  it('formats a short age', () => {
    expect(shortAgo('2026-11-27T11:59:30Z', now)).toBe('just now')
    expect(shortAgo('2026-11-27T11:15:00Z', now)).toBe('45m ago')
    expect(shortAgo('2026-11-27T02:00:00Z', now)).toBe('10h ago')
    expect(shortAgo('2026-11-25T12:00:00Z', now)).toBe('2d ago')
  })

  it('picks an Auto Edit vibe for a chart sound', () => {
    expect(vibeForSound({ bpm: 90, mood: 'chill' })).toBe('aesthetic')
    expect(vibeForSound({ bpm: 80, genre: 'Soundtrack', mood: 'epic' })).toBe('cinematic')
    expect(vibeForSound({ bpm: 100, genre: 'Dance' })).toBe('fun')
    expect(vibeForSound({ bpm: 128 })).toBe('energetic')
  })
})
