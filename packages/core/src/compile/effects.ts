/**
 * Clip effects (EffectPreset.effect) → FFmpeg.
 *
 * Effects split into two families:
 * - MOTION effects (shake, zoomPulse, beatZoom) contribute offset/zoom signals to the clip's
 *   geometry stage, so they cost one warp no matter how many are stacked and never reveal
 *   borders (shake adds just enough zoom to hide them);
 * - PIXEL effects are filters on the clip stream with an `enable='between(t,a,b)'` window
 *   (t = clip-local time), bypassed outside their window.
 *
 * Every numeric parameter can be overridden by the pack preset's `params`; `intensity`
 * (0..1) scales the effect strength. Sizes are canvas pixels at 1080 width × export scale.
 * Defaults (and the parameter names packs may set):
 *
 * | effect    | params (default)                                   | implementation                         |
 * | --------- | -------------------------------------------------- | -------------------------------------- |
 * | shake     | amplitude 18 px, frequency 14 Hz                   | geometry offset (+ cover zoom)         |
 * | zoomPulse | amount 0.08, frequency 2 Hz                        | geometry zoom × (1 + a·(1−cos)/2)      |
 * | beatZoom  | amount 0.12, bpm 120, decay 0.12 s                 | geometry zoom × (1 + a·e^(−phase/decay)) |
 * | rgbSplit  | offset 10 px                                       | chromashift                            |
 * | flash     | amount 0.8, decay 0.25 s, frequency 0 (once)       | eq brightness (eval=frame)             |
 * | blurIn    | amount 30 px                                       | gblur, sigma eased out via sendcmd     |
 * | vhs       | amount 1                                           | chromashift + noise + eq + soft blur   |
 * | glow      | amount 0.6, radius 24 px                           | ¼-res blurred copy screen-blended (luma) |
 * | strobe    | amount 0.6, frequency 8 Hz                         | eq brightness square wave              |
 * | filmGrain | amount 18                                          | temporal luma noise                    |
 */
import type { EffectRef } from '../schema.ts'
import type { EffectPreset } from '../packs.ts'
import { sampledCommands, sendcmdFilter } from './cmd.ts'
import { num } from './expr.ts'
import { filter } from './escape.ts'
import type { Graph } from './graph.ts'
import { constant, mul, add, type Signal } from './signal.ts'

/** Effect + its resolved preset and absolute (clip-relative) window. */
export interface ResolvedEffect {
  ref: EffectRef
  preset: EffectPreset
  /** Clip-relative window in us. */
  start: number
  end: number
}

/** Resolve a clip's effect refs, dropping unknown refs and empty windows. */
export function resolveEffects(
  effects: readonly EffectRef[],
  clipDuration: number,
  resolve: (ref: string) => EffectPreset | undefined,
): ResolvedEffect[] {
  const out: ResolvedEffect[] = []
  for (const ref of effects) {
    const preset = resolve(ref.ref)
    if (!preset || ref.intensity <= 0) continue
    const start = Math.min(ref.start, clipDuration)
    const end = Math.min(clipDuration, start + (ref.duration ?? clipDuration))
    if (end <= start) continue
    out.push({ ref, preset, start, end })
  }
  return out
}

const param = (e: ResolvedEffect, name: string, fallback: number): number => {
  const v = e.preset.params[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Motion contributions in canvas px (1080 space) and zoom multipliers. */
export interface Motion {
  dx: Signal
  dy: Signal
  zoom: Signal
}

/** 100 ms attack/release so motion effects never pop in. */
const envelope = (local: number, len: number): number =>
  Math.max(0, Math.min(1, local / 100_000, (len - local) / 100_000))
const envelopeExpr = (local: string, len: number): string =>
  `max(0,min(min(1,${local}/0.1),(${num(len / 1e6)}-${local})/0.1))`

/** Windowed signal helper: `inner(localSeconds)` inside [start,end], `outside` elsewhere. */
function inWindow(
  e: ResolvedEffect,
  outside: number,
  exprFn: (local: string) => string,
  atFn: (localUs: number) => number,
): Signal {
  const a = num(e.start / 1e6)
  const b = num(e.end / 1e6)
  return {
    constant: undefined,
    expr: (t) => `if(between(${t},${a},${b}),${exprFn(`(${t}-${a})`)},${num(outside)})`,
    at: (us) => (us >= e.start && us <= e.end ? atFn(us - e.start) : outside),
  }
}

const TAU = 2 * Math.PI

/** Combined geometry motion of the clip's motion effects. */
export function effectMotion(effects: readonly ResolvedEffect[]): Motion {
  const dx: Signal[] = []
  const dy: Signal[] = []
  const zoom: Signal[] = []
  for (const e of effects) {
    const I = e.ref.intensity
    const len = e.end - e.start
    switch (e.preset.effect) {
      case 'shake': {
        const A = param(e, 'amplitude', 18) * I
        const f = param(e, 'frequency', 14)
        const wave = (k1: number, p1: number, k2: number, p2: number) => ({
          expr: (l: string) =>
            `${num(A)}*${envelopeExpr(l, len)}*(0.65*sin(${num(TAU * f * k1)}*${l}+${num(p1)})+0.35*sin(${num(TAU * f * k2)}*${l}+${num(p2)}))`,
          at: (us: number) =>
            A *
            envelope(us, len) *
            (0.65 * Math.sin(TAU * f * k1 * (us / 1e6) + p1) +
              0.35 * Math.sin(TAU * f * k2 * (us / 1e6) + p2)),
        })
        const wx = wave(1, 0, 1.73, 1.3)
        const wy = wave(1.21, 0.7, 2.03, 2.1)
        dx.push(inWindow(e, 0, wx.expr, wx.at))
        dy.push(inWindow(e, 0, wy.expr, wy.at))
        // Enough extra zoom that a 1080-wide cover frame never shows an edge.
        const z = (2.2 * A) / 1080
        zoom.push(
          inWindow(
            e,
            1,
            (l) => `(1+${num(z)}*${envelopeExpr(l, len)})`,
            (us) => 1 + z * envelope(us, len),
          ),
        )
        break
      }
      case 'zoomPulse': {
        const a = param(e, 'amount', 0.08) * I
        const w = TAU * param(e, 'frequency', 2)
        zoom.push(
          inWindow(
            e,
            1,
            (l) => `(1+${num(a / 2)}*(1-cos(${num(w)}*${l})))`,
            (us) => 1 + (a / 2) * (1 - Math.cos((w * us) / 1e6)),
          ),
        )
        break
      }
      case 'beatZoom': {
        const a = param(e, 'amount', 0.12) * I
        const period = 60 / Math.max(1, param(e, 'bpm', 120))
        const decay = Math.max(0.01, param(e, 'decay', 0.12))
        zoom.push(
          inWindow(
            e,
            1,
            (l) => `(1+${num(a)}*exp(-mod(${l},${num(period)})/${num(decay)}))`,
            (us) => 1 + a * Math.exp(-((us / 1e6) % period) / decay),
          ),
        )
        break
      }
      default:
        break
    }
  }
  return { dx: add(...dx), dy: add(...dy), zoom: zoom.length ? mul(...zoom) : constant(1) }
}

/** True when any effect contributes motion. */
export const hasMotion = (effects: readonly ResolvedEffect[]): boolean =>
  effects.some((e) => ['shake', 'zoomPulse', 'beatZoom'].includes(e.preset.effect))

/**
 * Apply pixel effects to `label` (clip-local time). `scale` = export px per canvas px.
 * `size` is the stream's pixel size when known (needed for glow's blend).
 */
export function applyPixelEffects(
  g: Graph,
  label: string,
  effects: readonly ResolvedEffect[],
  o: { fps: number; scale: number; size?: { w: number; h: number } },
): string {
  let cur = label
  for (const e of effects) {
    const I = e.ref.intensity
    const S = o.scale
    const a = e.start / 1e6
    const b = e.end / 1e6
    const enable = `between(t,${num(a)},${num(b)})`
    const local = `(t-${num(a)})`
    switch (e.preset.effect) {
      case 'rgbSplit': {
        const d = Math.max(1, Math.round((param(e, 'offset', 10) * I * S) / 2))
        cur = g.chain(cur, [filter('chromashift', { cbh: -d, crh: d, enable })])
        break
      }
      case 'flash': {
        const amt = param(e, 'amount', 0.8) * I
        const decay = Math.max(0.01, param(e, 'decay', 0.25))
        const f = param(e, 'frequency', 0)
        const phase = f > 0 ? `mod(${local},${num(1 / f)})` : local
        cur = g.chain(cur, [
          filter('eq', {
            brightness: `${num(amt)}*exp(-${phase}/${num(decay)})`,
            eval: 'frame',
            enable,
          }),
        ])
        break
      }
      case 'blurIn': {
        const id = `gblur@${g.label('fx')}`
        const peak = param(e, 'amount', 30) * I * S
        const len = e.end - e.start
        const cmds = sampledCommands({
          target: id,
          command: 'sigma',
          signal: {
            constant: undefined,
            expr: () => '0',
            at: (us) => Math.max(0.01, peak * (1 - Math.min(1, us / len)) ** 2),
          },
          fromUs: 0,
          toUs: len,
          fps: o.fps,
          offsetUs: e.start,
          format: (v) => num(v, 2),
        })
        cur = g.chain(cur, [sendcmdFilter(cmds), filter(id, { sigma: peak, steps: 2, enable })])
        break
      }
      case 'vhs': {
        const k = param(e, 'amount', 1) * I
        const d = Math.max(1, Math.round(3 * S * k))
        cur = g.chain(cur, [
          filter('chromashift', { cbh: -d, crh: d, enable }),
          filter('noise', { c0s: Math.round(14 * k), c0f: 't', enable }),
          filter('eq', {
            saturation: num(1 + 0.25 * k),
            contrast: num(1 + 0.08 * k),
            gamma: num(1 + 0.05 * k),
            enable,
          }),
          filter('gblur', { sigma: Math.max(0.3, 0.8 * S * k), steps: 1, enable }),
        ])
        break
      }
      case 'glow': {
        if (!o.size) break
        const amt = Math.min(1, param(e, 'amount', 0.6) * I)
        const r = Math.max(1, (param(e, 'radius', 24) * S) / 4)
        const [main, src] = g.pair(cur)
        // Blur a quarter-resolution copy: 16× fewer pixels, visually identical for a glow.
        const blurred = g.chain(src, [
          `scale=${Math.max(2, Math.round(o.size.w / 8) * 2)}:${Math.max(2, Math.round(o.size.h / 8) * 2)}:flags=fast_bilinear`,
          filter('gblur', { sigma: r, steps: 2 }),
          `scale=${o.size.w}:${o.size.h}:flags=bilinear`,
        ])
        cur = g.add(
          [main, blurred],
          [filter('blend', { c0_mode: 'screen', c0_opacity: amt, enable })],
        )[0]!
        break
      }
      case 'strobe': {
        const amt = param(e, 'amount', 0.6) * I
        const f = Math.max(0.1, param(e, 'frequency', 8))
        cur = g.chain(cur, [
          filter('eq', {
            brightness: `if(lt(mod(${local}*${num(f)},1),0.5),${num(amt)},0)`,
            eval: 'frame',
            enable,
          }),
        ])
        break
      }
      case 'filmGrain': {
        const amt = Math.max(1, Math.round(param(e, 'amount', 18) * I))
        cur = g.chain(cur, [filter('noise', { c0s: amt, c0f: 't+u', enable })])
        break
      }
      default:
        break
    }
  }
  return cur
}
