/**
 * Deezer chart (api.deezer.com: public, no key; quota 50 requests / 5 s, we make ~11 a day):
 * the top tracks and, where Deezer knows it, their tempo (`/track/<id>` → `bpm`, cached for
 * 30 days). Only names and metadata are read: no audio is ever downloaded. Tracks without a
 * known tempo get a genre-based estimate later (see `bpm.ts`).
 */
import type { SourceContext, SourceItem, TrendSource } from '../types.ts'

interface DeezerTrack {
  id: number
  title_short?: string
  title: string
  bpm?: number
  artist?: { name: string }
}

export const parseDeezerChart = (json: string): DeezerTrack[] =>
  ((JSON.parse(json) as { data?: DeezerTrack[] }).data ?? []).filter((t) => t.id && t.title)

/** Plausible tempo or undefined (Deezer reports 0 for unknown). */
export const saneBpm = (bpm: number | undefined): number | undefined =>
  bpm !== undefined && Number.isFinite(bpm) && bpm >= 60 && bpm <= 200
    ? Math.round(bpm * 10) / 10
    : undefined

const tempoOf = async (ctx: SourceContext, t: DeezerTrack): Promise<number | undefined> => {
  try {
    const detail = JSON.parse(
      await ctx.get(`https://api.deezer.com/track/${t.id}`, { ttlMs: 30 * 86_400_000 }),
    ) as DeezerTrack
    return saneBpm(detail.bpm)
  } catch {
    // Tempo is a nice-to-have: the track still counts as a trending sound.
  }
  return undefined
}

export const deezer: TrendSource = {
  id: 'deezer',
  name: 'Deezer chart (with tempo)',
  disabledReason: () => undefined,
  async fetch(ctx) {
    const tracks = parseDeezerChart(
      await ctx.get('https://api.deezer.com/chart/0/tracks?limit=15', { ttlMs: 12 * 3_600_000 }),
    )
    const out: SourceItem[] = []
    for (const [i, t] of tracks.entries()) {
      // Sequential on purpose: polite to the API.
      // oxlint-disable-next-line no-await-in-loop
      const bpm = i < 10 ? await tempoOf(ctx, t) : undefined
      out.push({
        kind: 'sound',
        title: t.title_short || t.title,
        weight: 1 - i / Math.max(1, tracks.length),
        meta: { ...(t.artist ? { artist: t.artist.name } : {}), ...(bpm ? { bpm } : {}) },
      })
    }
    return out
  },
}
