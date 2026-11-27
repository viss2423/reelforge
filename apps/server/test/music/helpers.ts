/** Music test fixtures: recorded API responses, a synthetic "song" and a scripted fetch. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FetchLike } from '../../src/music/net.ts'
import type { MusicSource, SourceQuery, SourceTrack } from '../../src/music/types.ts'
import { ffmpeg } from '../ai/helpers.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Recorded API response (test/fixtures/music/<name>.json). */
export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'music', `${name}.json`), 'utf8'))

/** Song layout of `synthSong`: [start, end, level] seconds. */
export const SONG_SECTIONS = [
  [0, 12, 0.04], // quiet intro
  [12, 24, 0.6], // chorus
  [24, 36, 0.18], // verse
  [36, 48, 0.6], // chorus
  [48, 56, 0.04], // outro
] as const
export const SONG_BPM = 120

/**
 * A 56 s 120 BPM "song": sine pad + kick on every beat, with a quiet intro, two loud
 * choruses (12–24 s, 36–48 s), a medium verse and a quiet outro. Encoded as MP3.
 */
export const synthSong = (file: string, seconds = 56): string => {
  const level = SONG_SECTIONS.reduceRight<string>(
    (acc, [a, b, l]) => `if(between(t,${a},${b}),${l},${acc})`,
    '0.04',
  )
  const kick = `exp(-25*mod(t,0.5))*sin(2*PI*55*t)`
  const pad = `0.35*sin(2*PI*220*t)+0.2*sin(2*PI*330*t)`
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=exprs='${level}*(${pad}+0.9*${kick})':s=44100:d=${seconds}`,
    '-ac',
    '2',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    file,
  ])
  return file
}

export interface ScriptedFetch {
  fetch: FetchLike
  calls: string[]
}

/** fetch that answers from `routes` (URL prefix → JSON body, bytes, or a Response factory). */
export const scriptedFetch = (routes: Record<string, unknown>): ScriptedFetch => {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    if (key === undefined) return new Response('not found', { status: 404 })
    const v = routes[key]
    if (typeof v === 'function') return (v as () => Response)()
    if (Buffer.isBuffer(v))
      return new Response(new Uint8Array(v), { headers: { 'content-type': 'audio/mpeg' } })
    return new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
  }) as FetchLike
  return { fetch, calls }
}

/** In-memory source returning fixed tracks (counts calls; can be made to fail). */
export class FakeSource implements MusicSource {
  readonly id: string
  readonly name: string
  readonly homepage = 'https://example.org'
  tracks: SourceTrack[]
  calls: SourceQuery[] = []
  fail: string | undefined

  constructor(id: string, tracks: SourceTrack[]) {
    this.id = id
    this.name = id
    this.tracks = tracks
  }

  unavailable(): string | undefined {
    return undefined
  }

  async search(q: SourceQuery): Promise<SourceTrack[]> {
    this.calls.push(q)
    if (this.fail) throw new Error(this.fail)
    return this.tracks
  }
}

export const sourceTrack = (over: Partial<SourceTrack> & { id: string }): SourceTrack => ({
  source: over.id.split(':')[0]!,
  title: `Track ${over.id}`,
  artist: 'Artist',
  licence: { code: 'cc0', name: 'CC0 1.0', attributionRequired: false },
  duration: 56_000_000,
  tags: [],
  genres: [],
  cached: false,
  analyzed: false,
  audioUrl: `https://cdn.example.org/${encodeURIComponent(over.id)}.mp3`,
  ...over,
})
