/** Caption building: source-time transcripts → timeline-time caption words. */
import type { CaptionStyle, MediaClip, AudioClip, Project, Us, Word } from '../schema.ts'
import { clamp, clone } from './errors.ts'
import { mainTrackLayout } from './project.ts'
import { captionWindows } from './main.ts'
import { isFillerWord, normalizeWord } from './ranges.ts'
import { sourceRange, sourceToClipTimeExact, speedProfile } from './timemap.ts'

const POWER_WORDS = new Set([
  'best',
  'biggest',
  'crazy',
  'easy',
  'every',
  'fast',
  'free',
  'huge',
  'insane',
  'love',
  'money',
  'never',
  'new',
  'now',
  'only',
  'secret',
  'stop',
  'today',
  'worst',
  'wow',
])

/**
 * Heuristic keyword detection for automatic emphasis: numbers/prices/percentages, shouted
 * words (ALL CAPS), exclamations and a small list of high-attention "power words".
 */
export function isKeyword(text: string): boolean {
  const t = text.trim()
  if (/\p{N}/u.test(t)) return true
  if (t.endsWith('!')) return true
  const letters = t.replace(/[^\p{L}]/gu, '')
  if (letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase())
    return true
  return POWER_WORDS.has(normalizeWord(t))
}

/** A clip whose audio can carry speech, with the playback window it is captioned for. */
interface CaptionSource {
  clip: MediaClip | AudioClip
  /** Playback time of clip time 0. */
  origin: Us
  /** Clip-time window [a, b) whose words belong to this source. */
  window: [Us, Us]
}

function captionSources(p: Project): CaptionSource[] {
  const out: CaptionSource[] = []
  const layout = mainTrackLayout(p)
  const windows = captionWindows(layout)
  for (const track of p.tracks) {
    if (track.muted) continue
    if (track.kind === 'main') {
      layout.forEach((e, i) => {
        if (e.clip.type !== 'video' || e.clip.audio.muted) return
        const [a, b] = windows[i]!
        out.push({ clip: e.clip, origin: e.start, window: [a - e.start, b - e.start] })
      })
    } else if (track.kind === 'overlay' && !track.hidden) {
      for (const c of track.clips) {
        if (c.type === 'video' && !c.audio.muted) {
          out.push({ clip: c, origin: c.start, window: [0, c.duration] })
        }
      }
    } else if (track.kind === 'audio') {
      for (const c of track.clips) {
        if (c.type === 'audio' && c.role === 'voiceover' && !c.audio.muted) {
          out.push({ clip: c, origin: c.start, window: [0, c.duration] })
        }
      }
    }
  }
  return out
}

/** First index with words[i].start >= t (words sorted by start). */
function lowerBound(words: readonly Word[], t: number): number {
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (words[mid]!.start < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Longest word duration we expect from ASR; bounds the backwards search window. */
const MAX_WORD: Us = 30_000_000

/**
 * Build timeline-time captions from per-asset source-time transcripts. Every audible main
 * clip (and audible overlay video / voice-over clip) maps the words of its asset that it
 * actually plays: a word is kept when its midpoint is visible, then clamped to the clip.
 * Handles speed, ramps, reverse, cuts and the same asset used several times. Words are
 * sorted, filler words flagged and (optionally) keywords emphasised.
 */
export function buildCaptions(
  p: Project,
  transcripts: Readonly<Record<string, readonly Word[]>>,
  style: CaptionStyle,
  opts?: { styleRef?: string; language?: string },
): void {
  const sorted = new Map<string, Word[]>()
  const wordsOf = (assetId: string): Word[] => {
    let list = sorted.get(assetId)
    if (!list) {
      list = (transcripts[assetId] ?? []).toSorted((a, b) => a.start - b.start)
      sorted.set(assetId, list)
    }
    return list
  }

  const out: Word[] = []
  for (const src of captionSources(p)) {
    const words = wordsOf(src.clip.assetId)
    if (words.length === 0) continue
    const prof = speedProfile(src.clip)
    const range = sourceRange(src.clip, prof)
    const [w0, w1] = src.window
    for (let i = lowerBound(words, range.start - MAX_WORD); i < words.length; i++) {
      const w = words[i]!
      if (w.start > range.end) break
      const text = w.text.trim()
      if (text.length === 0 || w.end < w.start) continue
      const tauMid = sourceToClipTimeExact(src.clip, (w.start + w.end) / 2, prof)
      if (tauMid === undefined || tauMid < w0 || tauMid >= w1) continue
      const map = (s: number) =>
        clamp(sourceToClipTimeExact(src.clip, clamp(s, range.start, range.end), prof)!, w0, w1)
      let a = map(w.start)
      let b = map(w.end)
      if (a > b) [a, b] = [b, a]
      const start = Math.round(src.origin + a)
      const end = Math.max(start + 1, Math.round(src.origin + b))
      const word: Word = {
        ...clone(w),
        text,
        start,
        end,
        filler: w.filler || isFillerWord(text),
        emphasis: w.emphasis || (style.emphasizeKeywords && isKeyword(text)),
      }
      out.push(word)
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end)

  p.captions = {
    enabled: p.captions?.enabled ?? true,
    language: opts?.language ?? p.captions?.language ?? 'auto',
    words: out,
    style: clone(style),
    ...(opts?.styleRef !== undefined && { styleRef: opts.styleRef }),
  }
}
