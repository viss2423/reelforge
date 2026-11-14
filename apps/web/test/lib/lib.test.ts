import { sec } from '@reelforge/core'
import { describe, expect, it, vi } from 'vitest'
import { pairErrorMessage, safeNext } from '@/screens/PairScreen.tsx'
import { ApiError } from '@/api/client.ts'
import type { Packs } from '@/api/schemas.ts'
import { backingSize, fitAspect } from '@/editor/viewer/fit.ts'
import {
  estimateExportBytes,
  loadExportSettings,
  saveExportSettings,
  videoMbps,
} from '@/editor/export/estimate.ts'
import { exportFileName } from '@/exports/share.ts'
import { backoffDelay, isAbortError, sleep } from '@/lib/backoff.ts'
import { formatBytes, formatDuration, formatEta, formatRelative } from '@/lib/format.ts'
import { idbDelete, idbGet, idbKeys, idbSet } from '@/lib/idb.ts'
import { listTemplates, packFonts } from '@/lib/packs.ts'
import { discardSharedBatch, peekSharedBatch, putSharedBatch } from '@/lib/shareInbox.ts'

describe('backoff', () => {
  it('grows exponentially with full jitter and a cap', () => {
    const lo = () => 0
    const hi = () => 1
    expect(backoffDelay(0, { base: 500, random: hi })).toBe(500)
    expect(backoffDelay(3, { base: 500, random: hi })).toBe(4000)
    expect(backoffDelay(3, { base: 500, random: lo })).toBe(500)
    expect(backoffDelay(30, { base: 500, max: 10_000, random: hi })).toBe(10_000)
  })

  it('sleep resolves, and rejects with the abort reason', async () => {
    await expect(sleep(1)).resolves.toBeUndefined()
    const ctrl = new AbortController()
    const p = sleep(10_000, ctrl.signal)
    ctrl.abort(new DOMException('stop', 'AbortError'))
    await expect(p).rejects.toSatisfy(isAbortError)
    await expect(sleep(1, AbortSignal.abort())).rejects.toBeDefined()
  })

  it('isAbortError recognises DOMException and Error names', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true)
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })
})

describe('format', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 ** 3 * 4.25)).toBe('4.3 GB')
    expect(formatBytes(150 * 1024 ** 2)).toBe('150 MB')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  it('formatDuration', () => {
    expect(formatDuration(sec(7.4))).toBe('0:07')
    expect(formatDuration(sec(62))).toBe('1:02')
    expect(formatDuration(sec(3723))).toBe('1:02:03')
    expect(formatDuration(-5)).toBe('0:00')
  })

  it('formatEta', () => {
    expect(formatEta(undefined)).toBe('')
    expect(formatEta(sec(12))).toBe('12s left')
    expect(formatEta(sec(125))).toBe('2m 5s left')
    expect(formatEta(sec(3 * 3600 + 60))).toBe('3h 1m left')
  })

  it('formatRelative', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')
    expect(formatRelative('2026-01-01T11:57:00Z', now)).toMatch(/3 minutes ago/)
    expect(formatRelative('2025-12-31T12:00:00Z', now)).toMatch(/yesterday|1 day ago/)
    expect(formatRelative('garbage', now)).toBe('')
  })
})

describe('preview geometry', () => {
  it('fits the largest integer 9:16 box', () => {
    expect(fitAspect(1000, 1000)).toEqual({ width: 562, height: 999 })
    expect(fitAspect(360, 2000)).toEqual({ width: 360, height: 640 })
    expect(fitAspect(0, 100)).toEqual({ width: 0, height: 0 })
  })

  it('caps the backing store at 2× DPR', () => {
    expect(backingSize({ width: 100, height: 200 }, 3)).toEqual({ width: 200, height: 400 })
    expect(backingSize({ width: 100, height: 200 }, 0)).toEqual({ width: 100, height: 200 })
    expect(backingSize({ width: 100, height: 200 }, 1.5)).toEqual({ width: 150, height: 300 })
  })
})

describe('export estimate', () => {
  const base = { quality: 'high', resolution: '1080p', codec: 'h264' } as const
  it('scales with quality, resolution, codec and fps', () => {
    expect(videoMbps(base, 30)).toBe(16)
    expect(videoMbps({ ...base, codec: 'hevc' }, 30)).toBeCloseTo(10.4)
    expect(videoMbps({ ...base, resolution: '2160p' }, 30)).toBeCloseTo(51.2)
    expect(videoMbps(base, 60)).toBeGreaterThan(16)
  })

  it('estimates bytes for the duration or the range', () => {
    // 16 Mbit/s video + 0.32 Mbit/s audio for 10 s = 20.4 MB.
    expect(estimateExportBytes(base, 30, sec(10))).toBe(20_400_000)
    expect(
      estimateExportBytes({ ...base, range: { start: sec(2), end: sec(7) } }, 30, sec(10)),
    ).toBe(10_200_000)
  })

  it('remembers settings per device but never the range; survives bad storage', () => {
    const s = loadExportSettings()
    expect(s).toMatchObject({ resolution: '1080p', quality: 'high', codec: 'h264' })
    saveExportSettings({ ...s, quality: 'max', range: { start: 0, end: 5 } })
    expect(loadExportSettings()).toMatchObject({ quality: 'max' })
    expect(loadExportSettings().range).toBeUndefined()
    localStorage.setItem('rf.exportSettings', '{"quality":"bogus"}')
    expect(loadExportSettings().quality).toBe('high')
  })
})

describe('pairing helpers', () => {
  it('maps errors to actionable messages', () => {
    expect(pairErrorMessage(new ApiError(0, 'x'))).toMatch(/Can't reach/)
    expect(pairErrorMessage(new ApiError(403, 'x'))).toMatch(/wrong or has expired/)
    expect(pairErrorMessage(new ApiError(429, 'x'))).toMatch(/Too many attempts/)
    expect(pairErrorMessage(new ApiError(500, 'boom'))).toBe('boom')
    expect(pairErrorMessage('?')).toBe('Pairing failed')
  })

  it('only allows same-app redirects', () => {
    expect(safeNext('/p/1')).toBe('/p/1')
    expect(safeNext('//evil.com')).toBe('/')
    expect(safeNext('https://evil.com')).toBe('/')
    expect(safeNext(null)).toBe('/')
  })
})

describe('exportFileName', () => {
  it('produces a safe file name', () => {
    expect(exportFileName('Beach Day! 🌊', 'job_abcdef123456')).toBe('Beach-Day-123456.mp4')
    expect(exportFileName(undefined, 'j1')).toBe('reel-j1.mp4')
    expect(exportFileName('🌊🌊', 'j1')).toBe('reel-j1.mp4')
  })
})

describe('packs helpers', () => {
  const packs = {
    index: {
      version: '1',
      updatedAt: '',
      minAppVersion: '0.1.0',
      packs: [],
      fonts: [
        {
          family: 'Anton',
          license: 'OFL-1.1',
          files: [
            { path: 'fonts/Anton/Anton.ttf', sha256: '', size: 1, weight: 400, italic: false },
          ],
        },
      ],
    },
    manifests: [
      {
        id: 'p',
        templates: [
          {
            id: 'a',
            name: 'Alpha',
            trendScore: 50,
            thumb: 'a.jpg',
            slots: [{ duration: sec(1) }, { duration: sec(2) }],
          },
          { id: 'b', name: 'Beta', trendScore: 90, slots: [] },
          { id: 'c', name: 'Aardvark', trendScore: 50, slots: [] },
        ],
      },
    ],
  } as unknown as Packs

  it('lists templates by trend score then name, with refs and durations', () => {
    const list = listTemplates(packs)
    expect(list.map((t) => t.ref)).toEqual(['p/b', 'p/c', 'p/a'])
    expect(list[2]).toMatchObject({ thumbPath: 'p/a.jpg', duration: sec(3) })
    expect(listTemplates(undefined)).toEqual([])
  })

  it('maps pack fonts to URLs', () => {
    expect(packFonts(packs, (p) => `/f/${p}`)).toEqual([
      { family: 'Anton', url: '/f/fonts/Anton/Anton.ttf' },
    ])
    expect(packFonts(undefined, String)).toEqual([])
  })
})

describe('IndexedDB helpers', () => {
  it('get/set/delete/keys', async () => {
    await idbSet('drafts', 'k1', { a: 1 })
    await idbSet('drafts', 'k2', { a: 2 })
    expect(await idbGet('drafts', 'k1')).toEqual({ a: 1 })
    expect((await idbKeys('drafts')).toSorted()).toEqual(['k1', 'k2'])
    await idbDelete('drafts', 'k1')
    expect(await idbGet('drafts', 'k1')).toBeUndefined()
  })

  it('share inbox parks files without reading them', async () => {
    const file = new File(['abc'], 'clip.mp4', { type: 'video/mp4' })
    const read = vi.spyOn(file, 'arrayBuffer')
    const id = await putSharedBatch({ files: [file], title: 'Shared' })
    const batch = await peekSharedBatch(id)
    expect(batch?.title).toBe('Shared')
    expect(batch?.files).toHaveLength(1)
    expect(read).not.toHaveBeenCalled()
    await discardSharedBatch(id)
    expect(await peekSharedBatch(id)).toBeUndefined()
  })
})
