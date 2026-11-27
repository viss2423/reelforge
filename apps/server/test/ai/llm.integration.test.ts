/**
 * Real-model checks: llama-server + a GGUF model (installed by `pnpm bootstrap`, or pointed
 * at with REELFORGE_LLM_TEST_SERVER / REELFORGE_LLM_TEST_MODEL) answer the fixed evaluation
 * transcripts. Skipped with a printed reason when the runtime or model is absent.
 * Assertions are about structure and obvious quality (valid ids, a real hook, no greeting
 * as hook), not exact wording.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { writeCopy } from '../../src/ai/llm/copywriter.ts'
import { computeEmphasis } from '../../src/ai/llm/emphasis.ts'
import { computeHighlights } from '../../src/ai/llm/highlights.ts'
import { createLlm } from '../../src/ai/llm/port.ts'
import { findLlmInstall, type LlmInstall } from '../../src/ai/llm/runtime.ts'
import { buildSegments } from '../../src/ai/llm/segments.ts'
import { EVAL_SET, toWords } from './fixtures/llm-transcripts.ts'
import { DATA_DIR, makeTempDir, skipBecause } from './helpers.ts'

const envServer = process.env.REELFORGE_LLM_TEST_SERVER
const envModel = process.env.REELFORGE_LLM_TEST_MODEL
const install: LlmInstall | undefined =
  envServer && envModel && existsSync(envServer) && existsSync(envModel)
    ? { server: envServer, model: envModel, device: 'auto' }
    : findLlmInstall({ bin: path.join(DATA_DIR, 'bin'), models: path.join(DATA_DIR, 'models') })

const skipReason =
  !install && 'LLM runtime/model not installed — run `pnpm bootstrap` (or set REELFORGE_LLM_TEST_*)'

const tmp = makeTempDir('llm-int')
const llm = createLlm({
  paths: { bin: tmp.dir, models: tmp.dir, tmp: tmp.dir },
  install: () => install,
  idleMs: 600_000,
})
afterAll(async () => {
  await llm.unload()
  tmp.cleanup()
})

describe.skipIf(skipBecause(skipReason))('real LLM', () => {
  const t = EVAL_SET[0]!
  const { words, sentenceOf } = toWords(t)
  const src = {
    assetId: 'a',
    kind: 'video' as const,
    start: 0,
    end: words.at(-1)!.end + 500_000,
    words,
  }

  it('picks a real hook and skips greetings (grammar-constrained JSON)', async () => {
    const segs = buildSegments([src])
    const r = await computeHighlights({ sources: [src], target: 30_000_000, llm })
    expect(r.ranker).toBe('llm')
    const hook = r.variants[0]!.moments[0]!
    const sentence = sentenceOf[words.findIndex((w) => w.start >= segs[hook.segment]!.start)]!
    expect(t.hooks).toContain(sentence)
    expect(
      r.variants[0]!.moments.every(
        (m) =>
          !t.filler.includes(
            sentenceOf[words.findIndex((w) => w.start >= segs[m.segment]!.start)]!,
          ),
      ),
    ).toBe(true)
    expect(r.tokensPerSecond).toBeGreaterThan(0.5)
  })

  it('writes three short hooks, a caption and hashtags in the transcript language', async () => {
    const es = EVAL_SET.find((x) => x.language === 'es')!
    const c = await writeCopy({ llm, transcript: es.sentences.join(' '), language: 'es' })
    expect(c.hooks.length).toBeGreaterThanOrEqual(2)
    expect(c.hooks.every((h) => h.split(/\s+/).length <= 9)).toBe(true)
    expect(c.hashtags.length).toBeGreaterThanOrEqual(5)
    expect(c.caption.length).toBeGreaterThan(10)
  })

  it('chooses key words that are really in the text', async () => {
    const e = await computeEmphasis({ llm, words: words.map((w) => w.text), language: 'en' })
    expect(e.marks.length).toBeGreaterThan(2)
    expect(e.marks.every((m) => m.index >= 0 && m.index < words.length)).toBe(true)
  })
})
