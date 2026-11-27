/**
 * Beat grid of a trending sound for "Match cuts to this sound": FFmpeg decodes the official
 * 30 s preview straight from the provider's CDN into the beat tracker (Beat This! when
 * installed, else DSP) — the audio is never written anywhere. When there is no preview or
 * it cannot be analysed, a steady grid at the chart BPM is returned instead.
 */
import type { DataPaths } from '../contracts.ts'
import { analyzeBeats, analyzeBeatsNeural, findBeatModel } from '../ai/beats/index.ts'

export interface SoundBeats {
  bpm: number
  /** Beat / bar times from the start of the sound (µs). */
  beats: number[]
  downbeats: number[]
  /** Length the grid covers (µs). */
  duration: number
  engine: 'neural' | 'dsp' | 'grid'
}

const PREVIEW_US = 30_000_000

/** Steady 4/4 grid at `bpm` over `duration`. */
export const bpmGrid = (bpm: number, duration = PREVIEW_US): SoundBeats => {
  const step = 60_000_000 / bpm
  const beats: number[] = []
  for (let t = 0; t < duration; t += step) beats.push(Math.round(t))
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    duration,
    engine: 'grid',
  }
}

const cache = new Map<string, { at: number; value: SoundBeats }>()
let chain: Promise<unknown> = Promise.resolve()

/** One analysis at a time (it shares the CPU with the editor); results cached 30 min. */
export const analyzeSoundBeats = async (o: {
  paths: Pick<DataPaths, 'models'>
  ffmpeg: string
  url: string | undefined
  bpm?: number
  signal?: AbortSignal
}): Promise<SoundBeats> => {
  const fallback = (): SoundBeats => bpmGrid(o.bpm ?? 120)
  if (!o.url) return fallback()
  // Deezer preview URLs carry a short-lived token in the query: key on the path.
  const key = o.url.split('?')[0]!
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value
  const run = chain.then(async (): Promise<SoundBeats> => {
    try {
      const model = findBeatModel(o.paths as DataPaths)
      const common = { ffmpeg: o.ffmpeg, file: o.url!, ...(o.signal ? { signal: o.signal } : {}) }
      const r = model
        ? await analyzeBeatsNeural({ ...common, model })
        : { ...(await analyzeBeats(common)), engine: 'dsp' as const }
      if (r.beats.length < 8 || !(r.bpm > 0)) return fallback()
      const value: SoundBeats = {
        bpm: Math.round(r.bpm * 10) / 10,
        beats: r.beats,
        downbeats: r.downbeats,
        duration: PREVIEW_US,
        engine: r.engine,
      }
      cache.set(key, { at: Date.now(), value })
      return value
    } catch (err) {
      if (o.signal?.aborted) throw err
      return fallback()
    }
  })
  chain = run.catch(() => undefined)
  return run
}
