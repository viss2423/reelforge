/** Dialogue event collection and the override-tag helpers shared by text clips and captions. */
import type { TextStyle } from '../schema.ts'
import { assAlpha, assAlphaValue, csToAssTime, num } from './format.ts'
import type { PassAlphas } from './styles.ts'

export interface AssEvent {
  layer: number
  /** Centiseconds. */
  start: number
  /** Centiseconds (exclusive). */
  end: number
  style: string
  /** Override tags + escaped text. */
  text: string
}

/** Collects events; output is sorted by (start, layer, insertion order) for stable diffs. */
export class EventSink {
  private readonly events: Array<AssEvent & { seq: number }> = []
  private readonly window: { start: number; end: number } | undefined

  /** `window` (centiseconds) drops events entirely outside it. */
  constructor(window?: { start: number; end: number }) {
    this.window = window
  }

  /** Add an event; empty or out-of-window events are dropped. */
  push(e: AssEvent): void {
    if (e.end <= e.start) return
    if (this.window && (e.end <= this.window.start || e.start >= this.window.end)) return
    this.events.push({ ...e, seq: this.events.length })
  }

  get size(): number {
    return this.events.length
  }

  /** The complete `[Events]` section. */
  section(): string {
    const sorted = this.events.toSorted(
      (a, b) => a.start - b.start || a.layer - b.layer || a.seq - b.seq,
    )
    const lines = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ]
    for (const e of sorted) {
      lines.push(
        `Dialogue: ${e.layer},${csToAssTime(e.start)},${csToAssTime(e.end)},${e.style},,0,0,0,,${e.text}`,
      )
    }
    return lines.join('\n')
  }
}

/** `\1a\3a\4a` for the channel opacities of a pass at element opacity `o` (0..1). */
export function alphaTags(a: PassAlphas, o: number): string {
  return (
    `\\1a${assAlpha(assAlphaValue(a.fill, o))}` +
    `\\3a${assAlpha(assAlphaValue(a.outline, o))}` +
    `\\4a${assAlpha(assAlphaValue(a.shadow, o))}`
  )
}

/**
 * Rectangular `\clip` limiting a multi-line block's per-line BorderStyle-3 box to its own
 * line band. libass boxes are as tall as the font's cell (font dependent), so boxes of
 * adjacent lines would otherwise overlap and double-darken semi-transparent backgrounds.
 * Bands meet halfway between line centres; the outer edges of the block stay unclipped.
 */
export function bandClip(
  centerY: number,
  lineHeight: number,
  index: number,
  count: number,
): string {
  const top = index === 0 ? -1920 : centerY - lineHeight / 2
  const bottom = index === count - 1 ? 3840 : centerY + lineHeight / 2
  return `\\clip(-1080,${num(top)},2160,${num(bottom)})`
}

/** libass `\blur` strength for a CSS-like shadow blur radius (σ_css = r/2, σ_libass ≈ 0.85·b). */
export const blurStrength = (shadowBlur: number): number => shadowBlur * 0.59

/**
 * Per-pass tags that depend on the element scale `s` — libass does not scale borders,
 * shadows or blur with `\fscx`/`\fscy`, so they are scaled here. Border width equals the
 * style value at s = 1 and is omitted then unless `force` (a `\t` target must be explicit).
 */
export function scaledPassTags(
  style: TextStyle,
  pass: 'box' | 'shadow' | 'main',
  s: number,
  hardShadow: boolean,
  force = false,
): string {
  const bord = (w: number) => (s === 1 && !force ? '' : `\\bord${num(w * s)}`)
  switch (pass) {
    case 'box':
      return bord(style.backgroundPadding)
    case 'shadow':
      return `${bord(style.strokeWidth)}\\blur${num(blurStrength(style.shadowBlur) * s)}`
    case 'main': {
      let out = bord(style.strokeWidth)
      if (hardShadow) out += `\\xshad${num(style.shadowX * s)}\\yshad${num(style.shadowY * s)}`
      return out
    }
  }
}
