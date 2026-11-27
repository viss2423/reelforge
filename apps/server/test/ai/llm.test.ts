/**
 * Local LLM module: runtime discovery and argv, the llama-server lifecycle (lazy start, GPU →
 * CPU fallback, idle unload, serialised requests) against a fake child process + fake HTTP,
 * prompt/schema building and answer parsing for highlights, copywriter and emphasis, and
 * the jobs with a fake LlmPort.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { Word } from '@reelforge/core'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  cleanHashtags,
  cleanHook,
  condense,
  copyPrompt,
  COPY_SCHEMA,
  parseCopy,
} from '../../src/ai/llm/copywriter.ts'
import {
  chaptersPrompt,
  isEmoji,
  mapKeywords,
  parseChapters,
  sentenceStarts,
} from '../../src/ai/llm/emphasis.ts'
import {
  buildVariants,
  fitToTarget,
  heuristicRanking,
  highlightsPrompt,
  highlightsSchema,
  parseRanking,
  promptSegments,
  trimSegment,
  computeHighlights,
  type Ranking,
} from '../../src/ai/llm/highlights.ts'
import { createLlmJobs } from '../../src/ai/llm/jobs.ts'
import { chatBody, createLlm, createMutex, parseJsonOutput } from '../../src/ai/llm/port.ts'
import {
  findLlmInstall,
  generationThreads,
  LLAMA_SERVER_EXE,
  llamaServerArgs,
  pickModel,
} from '../../src/ai/llm/runtime.ts'
import {
  buildSegments,
  describeVisual,
  isSpeechSource,
  scoreSpeech,
  sentences,
  type Segment,
  type SourceInput,
} from '../../src/ai/llm/segments.ts'
import { spriteStats } from '../../src/ai/llm/visual.ts'
import { LlmUnavailableError, type LlmPort, type LlmRequest } from '../../src/ai/llm/types.ts'
import { EVAL_SET, toWords } from './fixtures/llm-transcripts.ts'
import { makeAsset, makeContext, makePaths, makeTempDir, MemoryStore } from './helpers.ts'

const SEC = 1_000_000
const tmp = makeTempDir('llm')
afterAll(() => tmp.cleanup())

const w = (text: string, start: number, end: number, extra: Partial<Word> = {}): Word => ({
  text,
  start,
  end,
  confidence: 0.9,
  filler: false,
  emphasis: false,
  ...extra,
})

/* ------------------------------------------------------------------ runtime */

describe('runtime', () => {
  it('picks the configured model, else the preference order, ignoring projectors', () => {
    const files = [
      'mmproj-F16.gguf',
      'gemma-4-E4B-it-Q4_K_M.gguf',
      'Qwen3.5-4B-Q4_K_M.gguf',
      'x.txt',
    ]
    expect(pickModel(files)).toBe('Qwen3.5-4B-Q4_K_M.gguf')
    expect(pickModel(files, 'gemma-4-E4B-it-Q4_K_M.gguf')).toBe('gemma-4-E4B-it-Q4_K_M.gguf')
    expect(pickModel(files, 'gone.gguf', 'gemma-4-E4B-it-Q4_K_M.gguf')).toBe(
      'gemma-4-E4B-it-Q4_K_M.gguf',
    )
    expect(pickModel(['mmproj-F16.gguf'])).toBeUndefined()
    expect(pickModel(['b.gguf', 'a.gguf'])).toBe('a.gguf')
  })

  it('finds the install from the data dir and honours env overrides', () => {
    const root = path.join(tmp.dir, 'data')
    const paths = { bin: path.join(root, 'bin'), models: path.join(root, 'models') }
    expect(findLlmInstall(paths, {})).toBeUndefined()
    mkdirSync(path.join(paths.bin, 'llm'), { recursive: true })
    writeFileSync(path.join(paths.bin, 'llm', LLAMA_SERVER_EXE), '')
    expect(findLlmInstall(paths, {})).toBeUndefined() // no model yet
    mkdirSync(path.join(paths.models, 'llm'), { recursive: true })
    writeFileSync(path.join(paths.models, 'llm', 'Qwen3.5-2B-Q4_K_M.gguf'), '')
    writeFileSync(path.join(paths.models, 'llm', 'Qwen3.5-4B-Q4_K_M.gguf'), '')
    expect(path.basename(findLlmInstall(paths, {})!.model)).toBe('Qwen3.5-4B-Q4_K_M.gguf')
    writeFileSync(
      path.join(paths.models, 'llm', 'default.json'),
      JSON.stringify({ model: 'Qwen3.5-2B-Q4_K_M.gguf' }),
    )
    const i = findLlmInstall(paths, { REELFORGE_LLM_DEVICE: 'cpu' })!
    expect(path.basename(i.model)).toBe('Qwen3.5-2B-Q4_K_M.gguf')
    expect(i.device).toBe('cpu')
  })

  it('builds a loopback, single-slot, reasoning-off argv for GPU and CPU', () => {
    const base = { model: 'm.gguf', port: 1234, apiKey: 'k', threads: 8, ctx: 8192 }
    const gpu = llamaServerArgs({ ...base, gpu: true })
    expect(gpu).toEqual(
      expect.arrayContaining(['--host', '127.0.0.1', '--port', '1234', '--api-key', 'k']),
    )
    expect(gpu.join(' ')).toContain('--parallel 1')
    expect(gpu.join(' ')).toContain('--reasoning off')
    expect(gpu.join(' ')).toContain('--n-gpu-layers 999')
    const cpu = llamaServerArgs({ ...base, gpu: false }).join(' ')
    expect(cpu).toContain('--n-gpu-layers 0')
    expect(cpu).toContain('--device none')
    expect(generationThreads(16)).toBe(8)
    expect(generationThreads(1)).toBe(1)
  })
})

/* ------------------------------------------------------------------ port + lifecycle */

interface FakeChild extends EventEmitter {
  pid: undefined
  exitCode: number | null
  signalCode: null
  stderr: PassThrough
  kill: () => boolean
}

/** A fake llama-server: a child that "listens" on the port in its argv until killed. */
const fakeRuntime = (opts: { failGpu?: boolean; delayMs?: number } = {}) => {
  const live = new Map<number, FakeChild>()
  const spawned: string[][] = []
  const requests: Array<{ url: string; body?: unknown }> = []
  let active = 0
  let maxActive = 0
  const spawnServer = (_exe: string, args: string[]): ChildProcess => {
    spawned.push(args)
    const port = Number(args[args.indexOf('--port') + 1])
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
      stderr: new PassThrough(),
      kill: () => {
        child.exitCode = 1
        live.delete(port)
        child.emit('exit', 1)
        return true
      },
    }) as FakeChild
    const gpu = args.includes('999')
    if (gpu && opts.failGpu) {
      setTimeout(() => {
        child.stderr.write('ggml_vulkan: error: out of memory\n')
        child.exitCode = 1
        child.emit('exit', 1)
      }, 5)
    } else live.set(port, child)
    return child as unknown as ChildProcess
  }
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const port = Number(new URL(url).port)
    if (!live.has(port)) throw new Error('ECONNREFUSED')
    if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 })
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    requests.push({ url, body })
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 5))
    active--
    const schema = (body.response_format as { json_schema?: unknown } | undefined)?.json_schema
    return Response.json({
      choices: [{ message: { content: schema ? '{"ok":true}' : 'hello' }, finish_reason: 'stop' }],
      timings: {
        prompt_n: 20,
        prompt_per_second: 150.04,
        predicted_n: 5,
        predicted_per_second: 12.34,
      },
    })
  }) as typeof fetch
  const killServer = (c: ChildProcess) => void c.kill()
  return {
    spawnServer,
    killServer,
    fetchImpl,
    spawned,
    requests,
    live,
    get maxActive() {
      return maxActive
    },
  }
}

const install = { server: 'llama-server', model: 'm.gguf', device: 'auto' as const }
const llmPaths = () => ({ bin: tmp.dir, models: tmp.dir, tmp: path.join(tmp.dir, 'run') })

describe('createLlm', () => {
  it('reports unavailable without an install and throws a clear error', async () => {
    const llm = createLlm({ paths: llmPaths(), install: () => undefined })
    expect(await llm.available()).toBe(false)
    await expect(llm.complete({ prompt: 'x' })).rejects.toBeInstanceOf(LlmUnavailableError)
    expect(await llm.info()).toBeUndefined()
  })

  it('starts lazily, constrains output with the schema and reports speed', async () => {
    const rt = fakeRuntime()
    const llm = createLlm({ paths: llmPaths(), install, ...rt, idleMs: 60_000 })
    expect(await llm.available()).toBe(true)
    expect(rt.spawned).toHaveLength(0)
    const r = await llm.complete({ system: 's', prompt: 'p', schema: { type: 'object' } })
    expect(r).toMatchObject({ text: '{"ok":true}', json: { ok: true }, tokensPerSecond: 12.3 })
    expect(r.promptTokensPerSecond).toBe(150)
    const body = rt.requests[0]!.body as Record<string, unknown>
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'p' },
    ])
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { schema: { type: 'object' } },
    })
    // Second request reuses the loaded model.
    await llm.complete({ prompt: 'again' })
    expect(rt.spawned).toHaveLength(1)
    expect(await llm.info()).toMatchObject({ model: 'm.gguf', backend: 'vulkan', loaded: true })
    await llm.unload()
    expect(rt.live.size).toBe(0)
  })

  it('serialises concurrent requests (one slot)', async () => {
    const rt = fakeRuntime({ delayMs: 20 })
    const llm = createLlm({ paths: llmPaths(), install, ...rt })
    await Promise.all([1, 2, 3, 4].map((i) => llm.complete({ prompt: String(i) })))
    expect(rt.maxActive).toBe(1)
    expect(
      rt.requests.map(
        (r) => (r.body as { messages: Array<{ content: string }> }).messages[0]!.content,
      ),
    ).toEqual(['1', '2', '3', '4'])
    await llm.unload()
  })

  it('falls back to the CPU when the GPU instance dies during load', async () => {
    const rt = fakeRuntime({ failGpu: true })
    const log = {
      info: vi.fn<(o: unknown) => void>(),
      warn: vi.fn<(o: unknown) => void>(),
      error: vi.fn<(o: unknown) => void>(),
      debug: vi.fn<(o: unknown) => void>(),
    }
    const llm = createLlm({ paths: llmPaths(), install, ...rt, log })
    await llm.complete({ prompt: 'x' })
    expect(rt.spawned).toHaveLength(2)
    expect(rt.spawned[1]).toContain('none')
    expect(log.warn).toHaveBeenCalled()
    expect((await llm.info())?.backend).toBe('cpu')
    await llm.unload()
  })

  it('unloads after the idle timeout and reloads on the next request', async () => {
    const rt = fakeRuntime()
    const llm = createLlm({ paths: llmPaths(), install, ...rt, idleMs: 30 })
    await llm.complete({ prompt: 'x' })
    expect(rt.live.size).toBe(1)
    await vi.waitFor(() => expect(rt.live.size).toBe(0), { timeout: 2000 })
    expect((await llm.info())?.loaded).toBe(false)
    await llm.complete({ prompt: 'y' })
    expect(rt.spawned).toHaveLength(2)
    await llm.unload()
  })

  it('honours abort signals', async () => {
    const rt = fakeRuntime({ delayMs: 50 })
    const llm = createLlm({ paths: llmPaths(), install, ...rt })
    const ac = new AbortController()
    ac.abort()
    await expect(llm.complete({ prompt: 'x', signal: ac.signal })).rejects.toThrow(/abort/i)
    expect(rt.spawned).toHaveLength(0)
    await llm.unload()
  })

  it('helpers: body defaults, fence-tolerant JSON, mutex ordering after failures', async () => {
    expect(chatBody({ prompt: 'p' })).toMatchObject({
      max_tokens: 512,
      temperature: 0.2,
      stream: false,
    })
    expect(chatBody({ prompt: 'p' })).not.toHaveProperty('response_format')
    expect(parseJsonOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    const m = createMutex()
    const order: number[] = []
    const a = m.run(async () => {
      order.push(1)
      throw new Error('boom')
    })
    const b = m.run(async () => {
      order.push(2)
      return 2
    })
    await expect(a).rejects.toThrow('boom')
    await expect(b).resolves.toBe(2)
    expect(order).toEqual([1, 2])
  })
})

/* ------------------------------------------------------------------ segments */

const evalSource = (i = 0): { src: SourceInput; sentenceOf: number[]; words: Word[] } => {
  const { words, sentenceOf } = toWords(EVAL_SET[i]!)
  return {
    src: { assetId: 'a1', kind: 'video', start: 0, end: words.at(-1)!.end + SEC, words },
    sentenceOf,
    words,
  }
}

describe('segments', () => {
  it('splits words into sentences at punctuation, long pauses and ~12 s', () => {
    const ws = [
      w('Hello', 0, 300_000),
      w('there.', 400_000, 700_000),
      w('Next', 800_000, 1_000_000),
      w('after', 2_000_000, 2_200_000), // 1 s pause
    ]
    expect(sentences(ws).map((s) => s.map((x) => x.text))).toEqual([
      ['Hello', 'there.'],
      ['Next'],
      ['after'],
    ])
    const long = Array.from({ length: 60 }, (_, i) =>
      w(i === 20 ? 'and,' : 'word', i * 300_000, i * 300_000 + 250_000),
    )
    const runs = sentences(long)
    expect(runs.length).toBeGreaterThan(1)
    expect(runs[0]!.at(-1)!.text).toBe('and,')
  })

  it('makes one speech segment per sentence with padding, trimming edge fillers', () => {
    const { src } = evalSource(0)
    const segs = buildSegments([src])
    expect(segs).toHaveLength(EVAL_SET[0]!.sentences.length)
    expect(segs.map((s) => s.id)).toEqual(segs.map((_, i) => i))
    expect(segs[1]!.text.startsWith('So')).toBe(true)
    for (let i = 1; i < segs.length; i++)
      expect(segs[i]!.start).toBeGreaterThanOrEqual(segs[i - 1]!.start)
    // Greetings score below the claim that makes a good hook.
    expect(segs[0]!.score).toBeLessThan(segs[2]!.score)
  })

  it('treats footage without speech as shots chunked to ~3 s, photos as one segment', () => {
    const src: SourceInput = {
      assetId: 'b',
      kind: 'video',
      start: 0,
      end: 10 * SEC,
      scenes: [4 * SEC],
    }
    expect(isSpeechSource(src)).toBe(false)
    const segs = buildSegments([src, { assetId: 'img', kind: 'image', start: 0, end: 0 }])
    expect(segs.filter((s) => s.assetId === 'b').map((s) => [s.start, s.end])).toEqual([
      [0, 4 * SEC],
      [4 * SEC, 7 * SEC],
      [7 * SEC, 10 * SEC],
    ])
    expect(segs.at(-1)).toMatchObject({ assetId: 'img', kind: 'image', end: 2 * SEC })
    expect(segs[0]!.text).toContain('no speech')
  })

  it('scores lively, keyword-rich speech above filler', () => {
    const lively = 'Nobody tells you this 1 secret that saves 300 dollars!'
      .split(' ')
      .map((t, i) => w(t, i * 300_000, i * 300_000 + 250_000))
    const filler = 'um so yeah uh like I mean okay'
      .split(' ')
      .map((t, i) => w(t, i * 500_000, i * 500_000 + 300_000, { filler: /^(um|uh)$/.test(t) }))
    expect(scoreSpeech(lively)).toBeGreaterThan(scoreSpeech(filler) + 0.2)
  })

  it('describes visual statistics in words and computes them from a sprite', () => {
    expect(describeVisual({ brightness: 0.8, contrast: 0.3, sharpness: 0.2, motion: 0.2 })).toBe(
      'bright · punchy · detailed · fast motion',
    )
    // 2 tiles of 4×2: a flat black tile then a checkerboard.
    const ix = { interval: SEC, columns: 2, rows: 1, tileWidth: 4, tileHeight: 2, count: 2 }
    const gray = new Uint8Array(16)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 4; x++) gray[y * 8 + 4 + x] = (x + y) % 2 ? 255 : 0
    const s = spriteStats(gray, 8, ix)
    expect(s[0]).toMatchObject({ t: 0, brightness: 0, contrast: 0, sharpness: 0 })
    expect(s[1]!.brightness).toBeCloseTo(0.5)
    expect(s[1]!.sharpness).toBeCloseTo(1)
    expect(s[1]!.motion).toBeCloseTo(0.5)
    expect(s[0]!.motion).toBe(s[1]!.motion)
  })
})

/* ------------------------------------------------------------------ highlights */

describe('highlights', () => {
  const { src, sentenceOf, words } = evalSource(0)
  const segs = buildSegments([src])
  const sentence = (seg: Segment) => sentenceOf[words.findIndex((x) => x.start >= seg.start)]!

  it('prompts with numbered segments, lengths, the target and the topic', () => {
    const p = highlightsPrompt({
      segments: segs,
      target: 30 * SEC,
      topic: 'phone tips',
      vibe: 'energetic',
    })
    expect(p).toContain('30 second reel')
    expect(p).toContain('Topic: phone tips')
    expect(p).toMatch(/#2 \(\d+\.\ds\) "Your phone charger/)
    const long = Array.from({ length: 200 }, (_, i) => ({ ...segs[0]!, id: i, score: i % 7 }))
    const shown = promptSegments(long, 50)
    expect(shown).toHaveLength(50)
    expect(shown.map((s) => s.id)).toEqual(shown.map((s) => s.id).toSorted((a, b) => a - b))
  })

  it('constrains ids to real segments in the schema', () => {
    const schema = highlightsSchema([0, 3, 5], 4) as {
      properties: {
        hook: { properties: { id: { enum: number[] } } }
        moments: { maxItems: number }
      }
    }
    expect(schema.properties.hook.properties.id.enum).toEqual([0, 3, 5])
    expect(schema.properties.moments.maxItems).toBe(4)
  })

  it('parses answers, dropping unknown and duplicate ids', () => {
    const r = parseRanking(
      {
        hook: { id: 2, why: ' bold claim ' },
        moments: [
          { id: 3, score: 8, why: 'a' },
          { id: 3, score: 9, why: 'dup' },
          { id: 99, score: 9, why: 'x' },
          { id: 2, score: 5, why: 'hook again' },
        ],
      },
      segs,
    )
    expect(r).toEqual({
      ranker: 'llm',
      hook: { id: 2, why: 'bold claim' },
      moments: [{ id: 3, score: 0.8, why: 'a' }],
    })
    expect(() => parseRanking({ hook: { id: 99, why: '' }, moments: [] }, segs)).toThrow(
      /unknown hook/,
    )
  })

  it('fits picks to the target: hook first, model order, CTA last, no unchosen filler', () => {
    const rank: Ranking = {
      ranker: 'llm',
      hook: { id: 2, why: 'claim' },
      moments: [11, 3, 4, 8, 9].map((id) => ({ id, score: 0.8, why: 'good' })),
    }
    const ms = fitToTarget(segs, rank, { target: 30 * SEC })
    const order = ms.map((m) => sentence(segs[m.segment]!))
    expect(order[0]).toBe(2)
    expect(ms[0]!.role).toBe('hook')
    expect(order.at(-1)).toBe(11) // "Follow for part two" → payoff
    expect(ms.at(-1)!.role).toBe('payoff')
    expect(order).not.toContain(0)
    expect(order).not.toContain(10)
    const total = ms.reduce((n, m) => n + m.end - m.start, 0)
    expect(total).toBeLessThanOrEqual(30 * SEC + 2.4 * SEC)
  })

  it('tops up a reel the model left far too short, from strong segments only', () => {
    const rank: Ranking = {
      ranker: 'llm',
      hook: { id: 2, why: 'claim' },
      moments: [{ id: 3, score: 0.9, why: 'x' }],
    }
    const ms = fitToTarget(segs, rank, { target: 30 * SEC })
    expect(ms.length).toBeGreaterThan(3)
    expect(ms.map((m) => sentence(segs[m.segment]!))).not.toContain(0)
  })

  it('trims long moments at word ends and builds distinct variants', () => {
    const seg = segs[8]! // long "The fix is simple…" sentence
    const cut = trimSegment(seg, 2 * SEC)
    expect(cut.end - cut.start).toBeLessThanOrEqual(2 * SEC)
    expect(seg.wordEnds).toContain(cut.end)
    const variants = buildVariants(segs, heuristicRanking(segs), 20 * SEC)
    expect(variants.map((v) => v.id)).toContain('story')
    expect(new Set(variants.map((v) => JSON.stringify(v.moments))).size).toBe(variants.length)
    const ids =
      variants
        .find((v) => v.id === 'chrono')
        ?.moments.slice(1)
        .map((m) => m.segment) ?? []
    expect(ids).toEqual(ids.toSorted((a, b) => a - b))
    for (const v of variants) expect(v.moments[0]!.role).toBe('hook')
  })

  it('runs heuristically without an LLM and with one when available', async () => {
    const plain = await computeHighlights({ sources: [src], target: 30 * SEC })
    expect(plain.ranker).toBe('heuristic')
    expect(plain.variants.length).toBeGreaterThan(0)
    const seen: LlmRequest[] = []
    const llm: LlmPort = {
      available: async () => true,
      complete: async (req) => {
        seen.push(req)
        return {
          text: '',
          json: {
            hook: { id: 9, why: 'result' },
            moments: [
              { id: 2, score: 9, why: 'claim' },
              { id: 4, score: 7, why: 'why' },
              { id: 8, score: 8, why: 'fix' },
            ],
          },
          tokensPerSecond: 10,
        }
      },
      info: async () => ({ model: 'fake.gguf', backend: 'cpu', loaded: true }),
    }
    const smart = await computeHighlights({ sources: [src], target: 30 * SEC, llm })
    expect(smart).toMatchObject({ ranker: 'llm', model: 'fake.gguf', tokensPerSecond: 10 })
    expect(smart.variants[0]!.moments[0]!.reason).toBe('result')
    expect(seen[0]!.schema).toBeDefined()
  })
})

/* ------------------------------------------------------------------ copywriter */

describe('copywriter', () => {
  it('prompts in the requested language and condenses long transcripts', () => {
    expect(copyPrompt({ transcript: 'hola', language: 'es' })).toContain(
      'Write everything in Spanish.',
    )
    expect(copyPrompt({ topic: 'travel' })).toContain('no speech')
    const long = 'word '.repeat(5000)
    const c = condense(long, 300)
    expect(c.length).toBeLessThanOrEqual(310)
    expect(c).toContain('…')
    expect(COPY_SCHEMA.properties.hooks.minItems).toBe(3)
  })

  it('cleans hooks and hashtags', () => {
    expect(cleanHook('  "Stop doing this #fail"  ')).toBe('Stop doing this')
    expect(cleanHashtags(['Travel Tips', '#travel', 'travel', '#', '#café', 'a'])).toEqual([
      '#traveltips',
      '#travel',
      '#café',
    ])
    expect(
      parseCopy({
        hooks: ['A b c', 'A b c', '"Hey you"'],
        caption: ' Nice ',
        hashtags: ['x1', 'y2'],
      }),
    ).toEqual({
      hooks: ['A b c', 'Hey you'],
      caption: 'Nice',
      hashtags: ['#x1', '#y2'],
    })
    expect(() => parseCopy({ hooks: ['', '#'], caption: 'c', hashtags: [] })).toThrow(
      /no usable hook/,
    )
  })
})

/* ------------------------------------------------------------------ emphasis */

describe('emphasis', () => {
  it('maps keywords onto first unmarked occurrences with capped emoji', () => {
    const words =
      'The battery is at one hundred percent and the battery is hot today so we wait a bit'.split(
        ' ',
      )
    const marks = mapKeywords(
      {
        keywords: [
          { word: 'battery', emoji: '🔋' },
          { word: 'Battery', emoji: '🔋' },
          { word: 'hundred percent', emoji: '💯' },
          { word: 'nothing', emoji: '' },
          { word: 'hot', emoji: 'nope' },
        ],
      },
      words,
      100,
    )
    expect(marks.map((m) => m.index)).toEqual([101, 105, 109])
    expect(marks.filter((m) => m.emoji)).toHaveLength(1)
    expect(isEmoji('🔥')).toBe(true)
    expect(isEmoji('👍🏽')).toBe(true)
    expect(isEmoji('🇪🇸')).toBe(true)
    expect(isEmoji('ok')).toBe(false)
  })

  it('numbers sentences for chapters and maps them back to word indices', () => {
    const words = 'One. Two words. Three here now. Four.'.split(' ')
    const starts = sentenceStarts(words)
    expect(starts).toEqual([0, 1, 3, 6])
    expect(chaptersPrompt(words, starts)).toContain('#2 Three here now.')
    expect(
      parseChapters(
        {
          chapters: [
            { sentence: 2, title: ' Middle ' },
            { sentence: 0, title: 'Intro' },
            { sentence: 9, title: 'x' },
          ],
        },
        starts,
      ),
    ).toEqual([
      { index: 0, title: 'Intro' },
      { index: 3, title: 'Middle' },
    ])
  })
})

/* ------------------------------------------------------------------ jobs */

describe('LLM jobs', () => {
  const root = path.join(tmp.dir, 'jobs')
  const paths = makePaths(root)
  const store = new MemoryStore()
  const { words } = toWords(EVAL_SET[1]!)
  store.putAsset(
    makeAsset('v1', 'pasta.mp4', {
      duration: words.at(-1)!.end + SEC,
      transcript: words,
      scenes: [],
    }),
  )

  const fakeLlm = (available: boolean): LlmPort => ({
    available: async () => available,
    complete: async (req) => {
      const props = (req.schema as { properties: Record<string, unknown> }).properties
      if ('hooks' in props)
        return {
          text: '',
          json: {
            hooks: ['One', 'Two two', 'Three'],
            caption: 'Cap tion',
            hashtags: ['#pasta', 'food'],
          },
          tokensPerSecond: 9,
        }
      if ('keywords' in props)
        return {
          text: '',
          json: { keywords: [{ word: 'pasta', emoji: '🍝' }] },
          tokensPerSecond: 9,
        }
      return {
        text: '',
        json: { hook: { id: 1, why: 'claim' }, moments: [{ id: 3, score: 9, why: 'secret' }] },
        tokensPerSecond: 9,
      }
    },
  })
  const jobs = (available: boolean) =>
    Object.fromEntries(createLlmJobs(() => fakeLlm(available)).map((j) => [j.kind, j]))

  it('registers three ai-class jobs', () => {
    const defs = createLlmJobs(() => fakeLlm(true))
    expect(defs.map((d) => [d.kind, d.resource])).toEqual([
      ['highlights', 'ai'],
      ['copywriter', 'ai'],
      ['emphasis', 'ai'],
    ])
  })

  it('highlights uses cached analysis and works without the LLM', async () => {
    for (const available of [true, false]) {
      const ctx = makeContext(
        'highlights',
        { sources: [{ assetId: 'v1' }], target: 20 * SEC },
        paths,
        store,
      )
      const r = (await jobs(available).highlights!.handler(ctx)) as {
        ranker: string
        variants: unknown[]
      }
      expect(r.ranker).toBe(available ? 'llm' : 'heuristic')
      expect(r.variants.length).toBeGreaterThan(0)
      expect(ctx.progressLog.at(-1)!.p).toBe(1)
    }
  })

  it('validates payloads', async () => {
    const ctx = makeContext('highlights', { sources: [], target: 1 }, paths, store)
    await expect(jobs(true).highlights!.handler(ctx)).rejects.toThrow(/invalid payload/)
  })

  it('copywriter and emphasis need the LLM and return cleaned output', async () => {
    const copyCtx = makeContext('copywriter', { assetIds: ['v1'], language: 'en' }, paths, store)
    expect(await jobs(true).copywriter!.handler(copyCtx)).toMatchObject({
      hooks: ['One', 'Two two', 'Three'],
      hashtags: ['#pasta', '#food'],
    })
    await expect(jobs(false).copywriter!.handler(copyCtx)).rejects.toBeInstanceOf(
      LlmUnavailableError,
    )
    const emCtx = makeContext('emphasis', { words: words.map((x) => x.text) }, paths, store)
    const em = (await jobs(true).emphasis!.handler(emCtx)) as {
      marks: Array<{ index: number; emoji?: string }>
    }
    expect(words[em.marks[0]!.index]!.text.toLowerCase()).toContain('pasta')
    await expect(jobs(false).emphasis!.handler(emCtx)).rejects.toBeInstanceOf(LlmUnavailableError)
  })
})
