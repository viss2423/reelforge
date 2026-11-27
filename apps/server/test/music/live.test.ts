/**
 * Live smoke test against the real catalogues (Openverse, ccMixter): opt in with
 * RF_MUSIC_LIVE=1. Prints suggestion latency cold vs cached (the numbers in README.md).
 * Never runs in CI by default: no network in tests, and the APIs' anonymous quotas are small.
 */
import { afterAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { MusicService } from '../../src/music/index.ts'
import { FFMPEG_BIN, makeTempDir, NO_FFMPEG, skipBecause } from '../ai/helpers.ts'

const LIVE = process.env.RF_MUSIC_LIVE === '1'

describe.skipIf(
  skipBecause(NO_FFMPEG) ||
    skipBecause(!LIVE && 'RF_MUSIC_LIVE=1 not set — live music smoke test skipped'),
)('music library (live)', () => {
  const tmp = makeTempDir('rf-music-live-')
  afterAll(() => tmp.cleanup())
  const svc = new MusicService({ dir: path.join(tmp.dir, 'music'), ffmpeg: FFMPEG_BIN })

  it(
    'suggests, analyses, previews — then answers from the cache',
    { timeout: 180_000 },
    async () => {
      const req = { mood: 'upbeat', duration: 20_000_000, hasSpeech: true, analyze: 2 } as const
      const cold = await svc.suggest(req)
      expect(cold.tracks.length).toBeGreaterThan(0)
      const best = cold.tracks[0]!
      expect(['cc0', 'pdm', 'by']).toContain(best.licence.code)
      expect(best.analyzed).toBe(true)
      const t0 = performance.now()
      await svc.library.preview(best.id)
      const previewMs = Math.round(performance.now() - t0)
      const warm = await svc.suggest(req)
      expect(warm.tracks.length).toBeGreaterThan(0)
      // Searches come from the day cache; only newly top-ranked tracks are downloaded.
      expect(svc.library.stats.searchCacheHits).toBeGreaterThanOrEqual(1)
      expect(svc.library.stats.downloads).toBeLessThanOrEqual(4)
      console.warn(
        `[music live] cold ${cold.tookMs} ms, cached ${warm.tookMs} ms, preview ${previewMs} ms, ` +
          `best "${best.title}" (${best.source}/${best.provider ?? '-'}, ${best.licence.name}, ` +
          `${best.bpm} BPM, energy ${best.energy}), stats ${JSON.stringify(svc.library.stats)}, ` +
          `warnings ${JSON.stringify(cold.warnings)}`,
      )
    },
  )
})
