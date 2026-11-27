/** AI caption styling: keyword emphasis + emoji on caption words, chapter markers. */
import { newId } from '../ids.ts'
import type { Project } from '../schema.ts'

export interface CaptionMark {
  /** Index into `captions.words`. */
  index: number
  /** Expected word text at that index (guards against edits made meanwhile). */
  text: string
  emoji?: string
}

/**
 * Replaces keyword emphasis (and emoji) on the captions with `marks`. Marks whose word no
 * longer matches are skipped. `chapters` become labelled user markers (previous AI chapter
 * markers are replaced). Returns how many words were emphasised.
 */
export function applyCaptionEmphasis(
  p: Project,
  marks: readonly CaptionMark[],
  chapters: readonly { index: number; title: string }[] = [],
): number {
  const words = p.captions?.words
  if (!words) return 0
  for (const w of words) {
    w.emphasis = false
    delete w.emoji
  }
  let n = 0
  for (const m of marks) {
    const w = words[m.index]
    if (!w || w.text !== m.text) continue
    w.emphasis = true
    if (m.emoji) w.emoji = m.emoji
    n++
  }
  if (chapters.length) {
    p.markers = p.markers.filter((mk) => !(mk.kind === 'user' && mk.id.startsWith('ch_')))
    for (const c of chapters) {
      const w = words[c.index]
      if (w)
        p.markers.push({ id: newId('ch_'), t: w.start, kind: 'user', label: c.title.slice(0, 100) })
    }
    p.markers.sort((a, b) => a.t - b.t)
  }
  return n
}
