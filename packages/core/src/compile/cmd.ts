/**
 * `sendcmd` generation: drives filters that lack per-frame expressions (e.g. `gblur` sigma,
 * `lut` alpha) by sampling a signal once per output frame. Commands are emitted only when
 * the quantised value changes, so a 2 s fade costs ~60 tiny LUT/kernel updates instead of
 * a per-pixel expression filter (`geq`).
 */
import { num } from './expr.ts'
import { filter } from './escape.ts'
import type { Signal } from './signal.ts'

export interface Command {
  /** Stream time in seconds at which the command fires. */
  t: number
  /** `filter@instance` */
  target: string
  command: string
  arg: string
}

/** Sample `signal(local)` per frame over [fromUs, toUs) and emit commands at stream time `local + offsetUs`. */
export function sampledCommands(o: {
  target: string
  command: string
  signal: Signal
  fromUs: number
  toUs: number
  fps: number
  offsetUs?: number
  /** Value → argument string (defaults to `num`). */
  format?: (v: number) => string
}): Command[] {
  const fmt = o.format ?? ((v: number) => num(v, 4))
  const out: Command[] = []
  const first = Math.max(0, Math.floor((o.fromUs * o.fps) / 1e6))
  const last = Math.ceil((o.toUs * o.fps) / 1e6)
  let prev: string | undefined
  for (let f = first; f <= last; f++) {
    const local = Math.min(o.toUs, (f * 1e6) / o.fps)
    const arg = fmt(o.signal.at(local))
    if (arg === prev) continue
    prev = arg
    // Fire half a frame early so the value is in place for the frame at `local`.
    const t = Math.max(0, (local + (o.offsetUs ?? 0)) / 1e6 - 0.5 / o.fps)
    out.push({ t, target: o.target, command: o.command, arg })
  }
  return out
}

/** A `sendcmd` filter for the commands (undefined when there are none). */
export function sendcmdFilter(commands: readonly Command[]): string | undefined {
  if (commands.length === 0) return undefined
  const sorted = commands.toSorted((a, b) => a.t - b.t)
  const text = sorted.map((c) => `${num(c.t)} ${c.target} ${c.command} ${c.arg}`).join(';')
  return filter('sendcmd', { c: text })
}
