/**
 * Test helpers for the render compiler: a reference FFmpeg expression evaluator (the subset
 * of libavutil/eval.c the compiler emits), an FFmpeg option unescaper, a filtergraph
 * validator and project / context factories.
 */
import { Project } from '../../src/schema.ts'
import type { EffectPreset } from '../../src/packs.ts'
import type { CompileAsset, CompileContext } from '../../src/compile/index.ts'

/* ------------------------------------------------------------------ expression evaluator */

type Fn = (args: number[], regs: number[]) => number

const FUNCTIONS: Record<string, Fn> = {
  if: ([c, a, b]) => (c ? a! : (b ?? 0)),
  ifnot: ([c, a, b]) => (!c ? a! : (b ?? 0)),
  lt: ([a, b]) => Number(a! < b!),
  lte: ([a, b]) => Number(a! <= b!),
  gt: ([a, b]) => Number(a! > b!),
  gte: ([a, b]) => Number(a! >= b!),
  eq: ([a, b]) => Number(a === b),
  between: ([x, a, b]) => Number(x! >= a! && x! <= b!),
  pow: ([a, b]) => a! ** b!,
  sin: ([a]) => Math.sin(a!),
  cos: ([a]) => Math.cos(a!),
  exp: ([a]) => Math.exp(a!),
  abs: ([a]) => Math.abs(a!),
  sqrt: ([a]) => Math.sqrt(a!),
  floor: ([a]) => Math.floor(a!),
  round: ([a]) => Math.round(a!),
  trunc: ([a]) => Math.trunc(a!),
  not: ([a]) => Number(!a),
  min: ([a, b]) => Math.min(a!, b!),
  max: ([a, b]) => Math.max(a!, b!),
  clip: ([x, lo, hi]) => Math.min(hi!, Math.max(lo!, x!)),
  mod: ([a, b]) => a! - b! * Math.floor(a! / b!),
  ld: ([i], regs) => regs[i!] ?? 0,
}

const CONSTANTS: Record<string, number> = { PI: Math.PI, E: Math.E }

/**
 * Evaluate an FFmpeg expression with the given variables. Mirrors eval.c's grammar:
 * `;`-separated sequence (value of the last), `+ -`, `* /`, unary sign, `^`, calls.
 */
export function evalExpr(src: string, vars: Record<string, number> = {}): number {
  let i = 0
  const regs: number[] = []
  const peek = (): string => src[i] ?? ''
  const fail = (msg: string): never => {
    throw new Error(`${msg} at ${i} in: ${src}`)
  }
  const sequence = (): number => {
    let v = sum()
    while (peek() === ';') {
      i++
      v = sum()
    }
    return v
  }
  const sum = (): number => {
    let v = term()
    while (peek() === '+' || peek() === '-') {
      // The sign belongs to the next factor (eval.c: a-b = a + (-b)).
      v += term()
    }
    return v
  }
  const term = (): number => {
    let v = factor()
    while (peek() === '*' || peek() === '/') {
      const op = src[i++]
      const r = factor()
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  const factor = (): number => {
    let sign = 1
    if (peek() === '+') i++
    else if (peek() === '-') {
      sign = -1
      i++
    }
    let v = primary()
    while (peek() === '^') {
      i++
      v = v ** factor()
    }
    return sign * v
  }
  const primary = (): number => {
    const numMatch = /^[-+]?(\d+\.?\d*|\.\d+)/.exec(src.slice(i))
    if (numMatch) {
      i += numMatch[0].length
      return Number(numMatch[0])
    }
    if (peek() === '(') {
      i++
      const v = sequence()
      if (peek() !== ')') fail('expected )')
      i++
      return v
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (!id) return fail('unexpected token')
    const name = id[0]
    i += name.length
    if (peek() === '(') {
      i++
      if (name === 'st') {
        const idx = sequence()
        if (peek() !== ',') fail('expected ,')
        i++
        const v = sequence()
        i++ // ')'
        regs[idx] = v
        return v
      }
      const args: number[] = []
      if (peek() !== ')') {
        args.push(sequence())
        while (peek() === ',') {
          i++
          args.push(sequence())
        }
      }
      if (peek() !== ')') fail('expected )')
      i++
      const fn = FUNCTIONS[name]
      if (!fn) return fail(`unknown function ${name}`)
      return fn(args, regs)
    }
    if (name in vars) return vars[name]!
    if (name in CONSTANTS) return CONSTANTS[name]!
    return fail(`unknown name ${name}`)
  }
  const v = sequence()
  if (i !== src.length) fail('trailing input')
  return v
}

/* ------------------------------------------------------------------ filtergraph parsing */

/**
 * One level of FFmpeg token unescaping (av_get_token): `\x` → `x`, `'…'` literal, stopping
 * at any unquoted character in `terms`.
 */
export function getToken(s: string, from: number, terms: string): { value: string; end: number } {
  let out = ''
  let i = from
  while (i < s.length && !terms.includes(s[i]!)) {
    const c = s[i]!
    if (c === '\\') {
      out += s[i + 1] ?? ''
      i += 2
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1)
      if (close === -1) throw new Error(`unterminated quote in ${s}`)
      out += s.slice(i + 1, close)
      i = close + 1
    } else {
      out += c
      i++
    }
  }
  return { value: out, end: i }
}

/** A filter of a parsed chain: name, optional `@instance` and unescaped option values. */
export interface ParsedFilter {
  name: string
  /** Positional (unnamed) values in order. */
  positional: string[]
  options: Record<string, string>
}

export interface ParsedChain {
  inputs: string[]
  outputs: string[]
  filters: ParsedFilter[]
}

function parseFilter(text: string): ParsedFilter {
  const eq = text.indexOf('=')
  const name = eq === -1 ? text : text.slice(0, eq)
  const positional: string[] = []
  const options: Record<string, string> = {}
  if (eq !== -1) {
    // Graph level was already removed by the chain splitter; option level: split on ':'.
    const args = text.slice(eq + 1)
    let i = 0
    while (i <= args.length) {
      const tok = getToken(args, i, ':')
      const raw = tok.value
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(raw)
      if (kv) options[kv[1]!] = kv[2]!
      else positional.push(raw)
      i = tok.end + 1
    }
  }
  return { name, positional, options }
}

/** Parse the compiler's filtergraph script into chains (graph-level unescaping applied). */
export function parseGraph(graph: string): ParsedChain[] {
  return graph
    .split(';\n')
    .filter((c) => c.trim().length > 0)
    .map((chain) => {
      let s = chain.trim()
      const inputs: string[] = []
      while (s.startsWith('[')) {
        const end = s.indexOf(']')
        inputs.push(s.slice(1, end))
        s = s.slice(end + 1)
      }
      const outputs: string[] = []
      while (s.endsWith(']')) {
        const start = s.lastIndexOf('[')
        outputs.unshift(s.slice(start + 1, -1))
        s = s.slice(0, start)
      }
      // Graph-level split on unquoted commas; each filter keeps its option-level escapes,
      // so only the graph-level quoting is removed here (quotes are kept by re-quoting).
      const filters: ParsedFilter[] = []
      let i = 0
      while (i < s.length) {
        let j = i
        let raw = ''
        while (j < s.length && s[j] !== ',') {
          if (s[j] === "'") {
            const close = s.indexOf("'", j + 1)
            raw += s.slice(j, close + 1)
            j = close + 1
          } else if (s[j] === '\\') {
            raw += s.slice(j, j + 2)
            j += 2
          } else {
            raw += s[j]
            j++
          }
        }
        filters.push(parseFilter(graphUnquote(raw)))
        i = j + 1
      }
      return { inputs, outputs, filters }
    })
}

/**
 * Remove the graph level of quoting: `'…'` content is literal, so option-level escapes
 * inside it survive for {@link parseFilter}.
 */
function graphUnquote(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c === "'") {
      const close = raw.indexOf("'", i + 1)
      out += raw.slice(i + 1, close)
      i = close
    } else if (c === '\\') {
      out += raw[i + 1] ?? ''
      i++
    } else {
      out += c
    }
  }
  return out
}

/**
 * Structural validity: every produced label is consumed exactly once (except `final`
 * labels, which must be produced and not consumed), and every stream input refers to an
 * existing ffmpeg input.
 */
export function validateGraph(graph: string, inputCount: number, final: readonly string[]): void {
  const chains = parseGraph(graph)
  const produced = new Map<string, number>()
  const consumed = new Map<string, number>()
  for (const c of chains) {
    if (c.filters.length === 0) throw new Error(`empty chain: ${JSON.stringify(c)}`)
    for (const o of c.outputs) {
      if (produced.has(o)) throw new Error(`label [${o}] produced twice`)
      produced.set(o, 1)
    }
    for (const l of c.inputs) {
      const m = /^(\d+):([av])$/.exec(l)
      if (m) {
        if (Number(m[1]) >= inputCount) throw new Error(`input ${l} out of range`)
        continue
      }
      if (!produced.has(l)) throw new Error(`label [${l}] consumed before it is produced`)
      consumed.set(l, (consumed.get(l) ?? 0) + 1)
    }
  }
  for (const [l, n] of consumed) if (n !== 1) throw new Error(`label [${l}] consumed ${n}×`)
  for (const l of produced.keys()) {
    const isFinal = final.includes(l)
    if (isFinal && consumed.has(l)) throw new Error(`final label [${l}] is consumed`)
    if (!isFinal && !consumed.has(l)) throw new Error(`label [${l}] is never consumed`)
  }
  for (const l of final) if (!produced.has(l)) throw new Error(`final label [${l}] missing`)
}

/** All filters of a graph, flattened. */
export const allFilters = (graph: string): ParsedFilter[] =>
  parseGraph(graph).flatMap((c) => c.filters)

/** Filters with the given name (instance suffix `@x` ignored). */
export const filtersNamed = (graph: string, name: string): ParsedFilter[] =>
  allFilters(graph).filter((f) => f.name.split('@')[0] === name)

/* ------------------------------------------------------------------ factories */

const NOW = '2026-01-01T00:00:00.000Z'

/** A probed compiler asset with sensible defaults. */
export function asset(
  id: string,
  over: Partial<CompileAsset> & Pick<CompileAsset, 'kind'>,
): CompileAsset {
  const isVideo = over.kind === 'video'
  return {
    id,
    name: `${id}.mp4`,
    size: 1,
    mime: 'video/mp4',
    createdAt: NOW,
    proxy: 'ready',
    thumbnails: 'ready',
    waveform: 'ready',
    hasAudio: isVideo || over.kind === 'audio',
    hasVideo: over.kind !== 'audio',
    width: over.kind === 'audio' ? undefined : 1920,
    height: over.kind === 'audio' ? undefined : 1080,
    duration: 60_000_000,
    path: `C:\\media\\${id}.bin`,
    ...over,
  }
}

/** Default asset set used across the compiler tests. */
export const ASSETS: Record<string, CompileAsset> = {
  land: asset('land', { kind: 'video' }),
  port: asset('port', { kind: 'video', width: 1080, height: 1920 }),
  rot: asset('rot', { kind: 'video', width: 1920, height: 1080, rotation: 90 }),
  silent: asset('silent', { kind: 'video', hasAudio: false }),
  img: asset('img', { kind: 'image', width: 800, height: 600, hasAudio: false }),
  music: asset('music', { kind: 'audio' }),
  voice: asset('voice', { kind: 'audio' }),
  hdr: asset('hdr', { kind: 'video', colorTransfer: 'arib-std-b67', colorPrimaries: 'bt2020' }),
  pq: asset('pq', { kind: 'video', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' }),
}

/** Effect presets keyed by ref `fx/<effect>`. */
export const EFFECTS: Record<string, EffectPreset> = Object.fromEntries(
  (
    [
      'shake',
      'zoomPulse',
      'rgbSplit',
      'flash',
      'blurIn',
      'vhs',
      'glow',
      'beatZoom',
      'strobe',
      'filmGrain',
    ] as const
  ).map((effect) => [
    `fx/${effect}`,
    { id: effect, name: effect, effect, params: {}, trendScore: 50, tags: [] },
  ]),
)

/** A compile context with deterministic paths and resolvers. */
export function ctx(over: Partial<CompileContext> = {}): CompileContext {
  return {
    assets: ASSETS,
    settings: {
      resolution: '1080p',
      codec: 'h264',
      encoder: 'cpu',
      quality: 'high',
      loudnessTarget: -14,
      normalizeLoudness: true,
    },
    output: 'C:\\out\\job.mp4.part',
    fontsDir: 'C:\\packs\\fonts',
    filterGraphPath: 'C:\\tmp\\graph.txt',
    resolveLut: (r) => (r === 'pack/teal' ? 'C:\\packs\\pack\\luts\\teal.cube' : undefined),
    resolveSticker: (r) => (r === 'pack/star' ? 'C:\\packs\\pack\\stickers\\star.png' : undefined),
    resolveEffect: (r) => EFFECTS[r],
    encoder: { video: 'libx264', args: ['-preset', 'medium', '-crf', '19'] },
    ...over,
  }
}

/** Build a valid project (zod fills defaults). */
export function project(tracks: unknown[], extra: Record<string, unknown> = {}): Project {
  return Project.parse({
    id: 'p1',
    name: 'test',
    createdAt: NOW,
    updatedAt: NOW,
    tracks: tracks.map((t, i) => ({ id: `t${i}`, ...(t as object) })),
    ...extra,
  })
}

/** Main-track video clips laid end to end. */
export function main(specs: Array<Record<string, unknown> & { duration: number }>): {
  kind: 'main'
  clips: unknown[]
} {
  let start = 0
  return {
    kind: 'main',
    clips: specs.map((s, i) => {
      const clip = { id: `m${i}`, type: 'video', assetId: 'land', start, ...s }
      start += s.duration
      return clip
    }),
  }
}

/** Value of an `-flag value` pair in an argv. */
export function argAfter(args: readonly string[], flag: string, nth = 0): string | undefined {
  let seen = 0
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && seen++ === nth) return args[i + 1]
  }
  return undefined
}
