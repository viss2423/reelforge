/**
 * Text clips → ASS events.
 *
 * A clip's on-screen pose (centre x/y, scale, rotation, opacity) is its transform keyframes
 * composed with its in/out/loop animations. The clip's lifetime is cut into SLICES on the
 * centisecond grid inside which every property is (within sub-pixel tolerance) linear; each
 * slice becomes one event per line and pass with `\pos`/`\move` plus a single `\t` that
 * interpolates scale, rotation, alpha and the scale-dependent border/shadow sizes. Slice
 * boundaries are the keyframe times of the transform and of the presets, refined by
 * adaptive bisection, so eased/back/elastic curves are followed closely with few events.
 *
 * Lines are separate events (positions computed here from fontSize × lineHeight) so line
 * spacing is deterministic; rotation, flips and scale act about the block centre via `\org`
 * and scaled line offsets. Per-character presets (typewriter, wipe) reveal glyphs with
 * inline `\t` alpha changes inside each slice event.
 */
import { characterReveal, evaluate, evaluatePreset, presetProgress } from '../animation.ts'
import type { AnimationSlot } from '../animation.ts'
import type { AnimationPreset } from '../packs.ts'
import type { TextClip, Us } from '../schema.ts'
import { alphaTags, bandClip, scaledPassTags, type EventSink } from './events.ts'
import { escapeAssText, num, toCs } from './format.ts'
import { fontSpec, measureText, wrapText } from './layout.ts'
import {
  PASS_LAYER,
  hasBox,
  hasHardShadow,
  hasSoftShadow,
  passAlphas,
  type Pass,
  type PassAlphas,
  type StyleRegistry,
} from './styles.ts'

/** An animation of a clip with its preset resolved. */
export interface ResolvedAnimation {
  slot: AnimationSlot
  preset: AnimationPreset
  duration: Us
}

/** On-screen pose of a text block. */
interface Pose {
  x: number
  y: number
  s: number
  r: number
  o: number
}

const TOL_PX = 1
const TOL_SCALE = 0.01
const TOL_DEG = 0.5
const TOL_ALPHA = 0.01
/** Upper bound on loop repetitions turned into breakpoints (a 10 min clip at 100 ms). */
const MAX_LOOP_BREAKS = 6000

/** Resolve a clip's in/out/loop animations (unknown refs are ignored). */
export function resolveAnimations(
  clip: Pick<TextClip, 'animationIn' | 'animationOut' | 'animationLoop'>,
  resolve: (ref: string) => AnimationPreset | undefined,
): ResolvedAnimation[] {
  const out: ResolvedAnimation[] = []
  const add = (slot: AnimationSlot, a: TextClip['animationIn']) => {
    if (!a || a.duration <= 0) return
    const preset = resolve(a.ref)
    if (preset) out.push({ slot, preset, duration: a.duration })
  }
  add('in', clip.animationIn)
  add('out', clip.animationOut)
  add('loop', clip.animationLoop)
  return out
}

/** Clip time τ at which a slot animation reaches preset progress p (in/out slots only). */
function slotTime(a: ResolvedAnimation, clipDuration: number, p: number): number {
  const d = Math.min(a.duration, clipDuration)
  if (a.slot === 'in') return a.preset.kind === 'out' ? (1 - p) * d : p * d
  const start = clipDuration - d
  return a.preset.kind === 'in' ? start + (1 - p) * d : start + p * d
}

function poseAt(clip: TextClip, anims: readonly ResolvedAnimation[], tau: number): Pose {
  let ax = 0
  let ay = 0
  let as = 1
  let ar = 0
  let ao = 1
  for (const a of anims) {
    const p = presetProgress(a.preset, a.slot, a.duration, clip.duration, tau)
    if (p === undefined) continue
    const v = evaluatePreset(a.preset, p)
    ax += v.x
    ay += v.y
    as *= v.scale
    ar += v.rotation
    ao *= v.opacity
  }
  const t = clip.transform
  const o = evaluate(t.opacity, tau) * ao
  return {
    x: evaluate(t.x, tau) + ax,
    y: evaluate(t.y, tau) + ay,
    s: Math.max(0, evaluate(t.scale, tau) * as),
    r: evaluate(t.rotation, tau) + ar,
    o: o <= 0 ? 0 : o >= 1 ? 1 : o,
  }
}

/** Breakpoints (clip time) where some property may change slope. */
function breakpoints(clip: TextClip, anims: readonly ResolvedAnimation[]): number[] {
  const D = clip.duration
  const out = [0, D]
  for (const key of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) {
    for (const k of clip.transform[key].keyframes) out.push(k.t)
  }
  for (const a of anims) {
    const d = Math.min(a.duration, D)
    const tracks = Object.values(a.preset.tracks).filter((tr) => tr !== undefined)
    if (a.slot === 'loop') {
      const reps = Math.min(Math.ceil(D / d), MAX_LOOP_BREAKS)
      for (let k = 0; k < reps; k++) {
        out.push(k * d)
        for (const tr of tracks) for (const kf of tr) out.push(k * d + kf.t * d)
      }
      continue
    }
    for (const tr of tracks) for (const kf of tr) out.push(slotTime(a, D, kf.t))
    out.push(slotTime(a, D, 0), slotTime(a, D, 1))
  }
  return out.filter((t) => t >= 0 && t <= D)
}

/** Geometry of the wrapped block (scale 1). */
interface Block {
  lines: string[]
  /** Vertical offset of each line centre from the block centre. */
  dy: number[]
  /** Horizontal offset of the line anchor from the block centre (alignment). */
  hx: number
  /** Largest |offset| of any anchor from the block centre (for error bounds). */
  reach: number
}

function layoutBlock(clip: TextClip): Block {
  const style = clip.style
  const text = style.uppercase ? clip.text.toUpperCase() : clip.text
  const font = fontSpec(style)
  const lines = wrapText(text, font, style.maxWidth)
  const lineHeight = style.fontSize * style.lineHeight
  const dy = lines.map((_, i) => (i - (lines.length - 1) / 2) * lineHeight)
  const width = Math.min(style.maxWidth, Math.max(0, ...lines.map((l) => measureText(l, font))))
  const hx = style.align === 'left' ? -width / 2 : style.align === 'right' ? width / 2 : 0
  const reach = Math.hypot(Math.abs(hx), Math.abs(dy[0] ?? 0))
  return { lines, dy, hx, reach }
}

/** Max deviation of the linear interpolation P0→P1 from the true pose at fraction f. */
function linearError(p0: Pose, p1: Pose, actual: Pose, f: number, reach: number): boolean {
  const lerp = (a: number, b: number) => a + (b - a) * f
  const ds = Math.abs(actual.s - lerp(p0.s, p1.s))
  if (Math.abs(actual.x - lerp(p0.x, p1.x)) > TOL_PX) return true
  if (Math.abs(actual.y - lerp(p0.y, p1.y)) > TOL_PX) return true
  if (ds > TOL_SCALE || ds * reach > TOL_PX) return true
  if (Math.abs(actual.r - lerp(p0.r, p1.r)) > TOL_DEG) return true
  if (Math.abs(actual.o - lerp(p0.o, p1.o)) > TOL_ALPHA) return true
  // \org is static within an event: a moving block that rotates drifts from its true origin.
  const rot = Math.max(Math.abs(actual.r), Math.abs(p1.r)) % 360
  if (rot > 0) {
    const drift = Math.hypot(actual.x - p0.x, actual.y - p0.y)
    if (drift * 2 * Math.sin((rot * Math.PI) / 360) > TOL_PX) return true
  }
  return false
}

/** Pose scale as an ASS `\fscx`/`\fscy` percentage. */
const pct = (p: Pose): string => num(p.s * 100)

const samePose = (a: Pose, b: Pose): boolean =>
  a.x === b.x && a.y === b.y && a.s === b.s && a.r === b.r && a.o === b.o

/** Per-character reveal state for the per-character presets of a clip. */
interface Reveal {
  anims: readonly ResolvedAnimation[]
  count: number
  /** Clip times where some character's reveal changes, per character: [τ, isStep]. */
  changes: Array<Array<[number, boolean]>>
}

function buildReveal(
  clip: TextClip,
  anims: readonly ResolvedAnimation[],
  count: number,
): Reveal | undefined {
  const perChar = anims.filter((a) => a.preset.perCharacter && a.slot !== 'loop')
  if (perChar.length === 0 || count === 0) return undefined
  const changes: Array<Array<[number, boolean]>> = []
  for (let i = 0; i < count; i++) {
    const list: Array<[number, boolean]> = []
    for (const a of perChar) {
      const track = a.preset.tracks.opacity
      if (!track) {
        // No opacity track: characterReveal steps from 0 to 1 when the character's slot ends.
        list.push([slotTime(a, clip.duration, (i + 1) / count), true])
        continue
      }
      for (let k = 0; k < track.length; k++) {
        const kf = track[k]!
        const tau = slotTime(a, clip.duration, (i + kf.t) / count)
        list.push([tau, k > 0 && kf.easing === 'hold'])
        if (k > 0 && kf.easing !== 'hold' && kf.easing !== 'linear') {
          // Curved reveal: one extra sample at the segment midpoint.
          const mid = (track[k - 1]!.t + kf.t) / 2
          list.push([slotTime(a, clip.duration, (i + mid) / count), false])
        }
      }
    }
    list.sort((x, y) => x[0] - y[0])
    changes.push(list)
  }
  return { anims: perChar, count, changes }
}

function revealAt(clip: TextClip, reveal: Reveal, i: number, tau: number): number {
  let r = 1
  for (const a of reveal.anims) {
    const p = presetProgress(a.preset, a.slot, a.duration, clip.duration, tau)
    if (p !== undefined) r *= characterReveal(a.preset, i, reveal.count, p)
  }
  return r
}

/**
 * The common reveal value of characters [first, first + n) when it is constant over the
 * slice (ta, tb], or undefined when some character changes inside it or they differ. Static
 * slices are written with line-level alpha tags instead of per-character ones.
 */
function staticReveal(
  clip: TextClip,
  reveal: Reveal,
  first: number,
  n: number,
  ta: number,
  tb: number,
): number | undefined {
  let value: number | undefined
  for (let i = first; i < first + n; i++) {
    for (const [tau] of reveal.changes[i]!) if (tau > ta && tau <= tb) return undefined
    const v = revealAt(clip, reveal, i, ta)
    if (value === undefined) value = v
    else if (v !== value) return undefined
  }
  return value
}

/** A slice in clip time with its event-relative millisecond frame and opacity at both ends. */
interface SliceFrame {
  ta: number
  tb: number
  startMs: number
  durMs: number
  o0: number
  o1: number
}

/**
 * Escaped text of `chars` with per-character reveal tags for one slice. Every character
 * carries its full alpha state (inline tags persist to following characters); consecutive
 * characters with identical static state share one tag block. The element opacity of a
 * revealing character is taken at the slice start — slices rarely animate both at once.
 */
function revealText(
  clip: TextClip,
  reveal: Reveal,
  chars: readonly string[],
  firstIndex: number,
  slice: SliceFrame,
  alphas: PassAlphas,
): string {
  const msAt = (tau: number) =>
    Math.min(slice.durMs, Math.max(0, Math.round((clip.start + tau) / 1000) - slice.startMs))
  let out = ''
  let prevTags = ''
  chars.forEach((ch, j) => {
    const i = firstIndex + j
    let value = revealAt(clip, reveal, i, slice.ta)
    let tags = alphaTags(alphas, slice.o0 * value)
    let prevMs = 0
    let animated = false
    for (const [tau, step] of reveal.changes[i]!) {
      if (tau <= slice.ta || tau > slice.tb) continue
      const ms = msAt(tau)
      // Steps are evaluated just past the boundary so float error cannot miss them.
      const next = revealAt(clip, reveal, i, step ? tau + 0.5 : tau)
      if (next !== value) {
        const t0 = step ? Math.max(0, ms - 1) : prevMs
        tags += `\\t(${t0},${Math.max(ms, t0 + 1)},${alphaTags(alphas, slice.o0 * next)})`
        value = next
        animated = true
      }
      prevMs = ms
    }
    if (!animated && slice.o1 !== slice.o0) {
      tags += `\\t(${alphaTags(alphas, slice.o1 * value)})`
      animated = true
    }
    if (animated || tags !== prevTags) out += `{${tags}}`
    prevTags = animated ? '' : tags
    out += escapeAssText(ch)
  })
  return out
}

/** Emit all events of one visible text clip on `layerBase`..`layerBase+2`. */
export function emitTextClip(
  clip: TextClip,
  anims: readonly ResolvedAnimation[],
  layerBase: number,
  styles: StyleRegistry,
  sink: EventSink,
): void {
  if (clip.text.trim() === '') return
  const style = clip.style
  const block = layoutBlock(clip)
  const passes: Pass[] = []
  if (hasBox(style)) passes.push('box')
  if (hasSoftShadow(style)) passes.push('shadow')
  passes.push('main')
  const hardShadow = hasHardShadow(style)
  const styleNames = passes.map((pass) => styles.get(style, pass))
  const alphas = passes.map((pass) => passAlphas(style, pass))

  const lineChars = block.lines.map((l) => Array.from(l))
  const firstIndex: number[] = []
  let count = 0
  for (const chars of lineChars) {
    firstIndex.push(count)
    count += chars.length
  }
  const reveal = buildReveal(clip, anims, count)
  const flipTags = `${clip.transform.flipH ? '\\fry180' : ''}${clip.transform.flipV ? '\\frx180' : ''}`

  const cs0 = toCs(clip.start)
  const cs1 = toCs(clip.start + clip.duration)
  if (cs1 <= cs0) return
  const tauAt = (cs: number) => Math.min(clip.duration, Math.max(0, cs * 10_000 - clip.start))
  const poseCache = new Map<number, Pose>()
  const pose = (cs: number): Pose => {
    let p = poseCache.get(cs)
    if (!p) poseCache.set(cs, (p = poseAt(clip, anims, tauAt(cs))))
    return p
  }

  // Slice boundaries on the centisecond grid, refined until every slice is linear.
  const grid = [...new Set(breakpoints(clip, anims).map((t) => toCs(clip.start + t)))]
    .filter((c) => c >= cs0 && c <= cs1)
    .toSorted((a, b) => a - b)
  if (grid[0] !== cs0) grid.unshift(cs0)
  if (grid[grid.length - 1] !== cs1) grid.push(cs1)
  const cuts: number[] = [cs0]
  const refine = (a: number, b: number) => {
    if (b - a >= 2) {
      const p0 = pose(a)
      const p1 = pose(b)
      for (const f of [0.25, 0.5, 0.75]) {
        const c = a + Math.round((b - a) * f)
        if (c <= a || c >= b) continue
        if (linearError(p0, p1, pose(c), (c - a) / (b - a), block.reach)) {
          const mid = (a + b) >>> 1
          refine(a, mid)
          refine(mid, b)
          return
        }
      }
    }
    cuts.push(b)
  }
  for (let k = 1; k < grid.length; k++) refine(grid[k - 1]!, grid[k]!)

  // Merge consecutive constant slices with identical poses (no information lost).
  const slices: Array<[number, number]> = []
  for (let k = 1; k < cuts.length; k++) {
    const a = cuts[k - 1]!
    const b = cuts[k]!
    const last = slices[slices.length - 1]
    if (last && samePose(pose(a), pose(b)) && samePose(pose(last[0]), pose(last[1]))) {
      last[1] = b
    } else slices.push([a, b])
  }

  for (const [a, b] of slices) {
    const p0 = pose(a)
    const p1 = pose(b)
    const durMs = (b - a) * 10
    const animS = p0.s !== p1.s
    const animR = p0.r !== p1.r
    const rotated = p0.r !== 0 || p1.r !== 0 || flipTags !== ''
    passes.forEach((pass, k) => {
      const ox = pass === 'shadow' ? style.shadowX : 0
      const oy = pass === 'shadow' ? style.shadowY : 0
      block.lines.forEach((line, li) => {
        if (line.trim() === '') return
        const at = (p: Pose) => ({
          x: p.x + (block.hx + ox) * p.s,
          y: p.y + (block.dy[li]! + oy) * p.s,
        })
        const q0 = at(p0)
        const q1 = at(p1)
        // Per-character reveal tags only where some character of this line changes.
        const still = reveal
          ? staticReveal(clip, reveal, firstIndex[li]!, lineChars[li]!.length, tauAt(a), tauAt(b))
          : 1
        const dynamic = still === undefined ? reveal : undefined
        const o0 = p0.o * (still ?? 1)
        const o1 = p1.o * (still ?? 1)
        if (!dynamic && o0 === 0 && o1 === 0) return
        let tags = '\\q2'
        tags +=
          num(q0.x) === num(q1.x) && num(q0.y) === num(q1.y)
            ? `\\pos(${num(q0.x)},${num(q0.y)})`
            : `\\move(${num(q0.x)},${num(q0.y)},${num(q1.x)},${num(q1.y)})`
        if (rotated) tags += `\\org(${num(p0.x + ox * p0.s)},${num(p0.y + oy * p0.s)})`
        if (p0.s !== 1 || animS) tags += `\\fscx${pct(p0)}\\fscy${pct(p0)}`
        tags += scaledPassTags(style, pass, p0.s, hardShadow)
        if (p0.r !== 0) tags += `\\frz${num(-p0.r)}`
        tags += flipTags
        if (o0 !== 1 && !dynamic) tags += alphaTags(alphas[k]!, o0)
        let t = ''
        if (animS) {
          t += `\\fscx${pct(p1)}\\fscy${pct(p1)}`
          t += scaledPassTags(style, pass, p1.s, hardShadow, true)
        }
        if (animR) t += `\\frz${num(-p1.r)}`
        if (o1 !== o0 && !dynamic) t += alphaTags(alphas[k]!, o1)
        if (pass === 'box' && !rotated && block.lines.length > 1) {
          const band = (p: Pose, y: number) =>
            bandClip(y, style.fontSize * style.lineHeight * p.s, li, block.lines.length)
          const c0 = band(p0, q0.y)
          const c1 = band(p1, q1.y)
          tags += c0
          if (c1 !== c0) t += c1
        }
        if (t !== '') tags += `\\t(${t})`
        const body = dynamic
          ? revealText(
              clip,
              dynamic,
              lineChars[li]!,
              firstIndex[li]!,
              { ta: tauAt(a), tb: tauAt(b), startMs: a * 10, durMs, o0: p0.o, o1: p1.o },
              alphas[k]!,
            )
          : escapeAssText(line)
        sink.push({
          layer: layerBase + PASS_LAYER[pass],
          start: a,
          end: b,
          style: styleNames[k]!,
          text: `{${tags}}${body}`,
        })
      })
    })
  }
}
