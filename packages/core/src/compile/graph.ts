/**
 * Minimal filtergraph builder. Labels are allocated sequentially; every produced label must be
 * consumed exactly once (FFmpeg rejects dangling or reused pads), so streams that feed several
 * consumers go through {@link Graph.split}.
 */
import type { Us } from '../schema.ts'
import { CompileError } from './errors.ts'
import { secs } from './expr.ts'

/** A filter or a falsy placeholder (skipped), so chains can be written declaratively. */
export type MaybeFilter = string | undefined | null | false

/** Input specification for one `-i` of the ffmpeg command. */
export interface InputSpec {
  path: string
  /** Input-side seek (fast keyframe seek + accurate decode). */
  seek?: Us
  /** Input-side duration limit. */
  duration?: Us
  /** `-vn`: only the audio stream is used. */
  audioOnly?: boolean
  /** `-hwaccel <x>` for video decoding. */
  hwaccel?: string
}

export class Graph {
  private readonly chains: string[] = []
  private readonly inputSpecs: InputSpec[] = []
  private readonly inputKeys = new Map<string, number>()
  private next = 0

  /** Register (or reuse) an ffmpeg input; returns its index. */
  input(spec: InputSpec): number {
    const key = JSON.stringify([
      spec.path,
      spec.seek ?? null,
      spec.duration ?? null,
      spec.audioOnly ?? false,
      spec.hwaccel ?? null,
    ])
    const existing = this.inputKeys.get(key)
    if (existing !== undefined) return existing
    const index = this.inputSpecs.length
    this.inputSpecs.push(spec)
    this.inputKeys.set(key, index)
    return index
  }

  /** ffmpeg argv for all registered inputs. */
  inputArgs(): string[] {
    const args: string[] = []
    for (const s of this.inputSpecs) {
      if (s.hwaccel) args.push('-hwaccel', s.hwaccel)
      if (s.seek !== undefined && s.seek > 0) args.push('-ss', secs(s.seek))
      if (s.duration !== undefined) args.push('-t', secs(s.duration))
      if (s.audioOnly) args.push('-vn')
      args.push('-i', s.path)
    }
    return args
  }

  get inputCount(): number {
    return this.inputSpecs.length
  }

  /** Allocate a fresh, unused label name. */
  label(prefix = 's'): string {
    return `${prefix}${this.next++}`
  }

  /**
   * Add `[in1][in2]f1,f2,…[out…]`. Returns the produced labels. With no filters and a single
   * input the input label is returned unchanged (no-op chains are elided).
   */
  add(inputs: readonly string[], filters: readonly MaybeFilter[], outputs = 1): string[] {
    const fs = filters.filter((f): f is string => typeof f === 'string' && f.length > 0)
    if (fs.length === 0) {
      if (inputs.length === 1 && outputs === 1) return [inputs[0]!]
      throw new CompileError('empty_chain', 'filter chain with multiple pads needs a filter')
    }
    const outs = Array.from({ length: outputs }, () => this.label())
    const ins = inputs.map((l) => `[${l}]`).join('')
    this.chains.push(`${ins}${fs.join(',')}${outs.map((l) => `[${l}]`).join('')}`)
    return outs
  }

  /** One input → one output chain; returns the output label (or the input if no filters). */
  chain(input: string, filters: readonly MaybeFilter[]): string {
    return this.add([input], filters)[0]!
  }

  /** Source chain with no input pads (e.g. `color=…`, `anullsrc=…`). */
  source(filters: readonly MaybeFilter[]): string {
    const fs = filters.filter((f): f is string => typeof f === 'string' && f.length > 0)
    const out = this.label()
    this.chains.push(`${fs.join(',')}[${out}]`)
    return out
  }

  /** Duplicate a stream for `n` consumers (video `split` or audio `asplit`). */
  split(input: string, n: number, audio = false): string[] {
    if (n <= 1) return [input]
    return this.add([input], [`${audio ? 'asplit' : 'split'}=${n}`], n)
  }

  /** Duplicate a stream for exactly two consumers. */
  pair(input: string, audio = false): [string, string] {
    const [a, b] = this.add([input], [audio ? 'asplit=2' : 'split=2'], 2)
    return [a!, b!]
  }

  /** The filtergraph script (one chain per line for readability). */
  toString(): string {
    return this.chains.join(';\n')
  }
}
