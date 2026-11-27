# Local AI assistant (LLM)

A fully local language model that makes edits better: it picks the hook and the best moments
of your footage (**highlights**), writes hook titles, a post caption and hashtags in the
video's language (**copywriter**), chooses caption keywords/emoji and chapters
(**emphasis**), and powers the one-tap **Auto edit** (with Magic edit using highlights too).
Nothing leaves the host.

```ts
import { createLlm, type LlmPort } from './llm/index.ts'

interface LlmPort {
  available(): Promise<boolean>
  complete(req: {
    system?: string
    prompt: string
    schema?: object // JSON Schema → grammar-constrained decoding, output always parses
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  }): Promise<{ text: string; json?: unknown; tokensPerSecond: number }>
}
```

`createLlm(deps)` is the port; `sharedLlm(paths)` is the process-wide instance the jobs use.
Other modules take an `LlmPort` and tests pass a fake.

## How it runs

- **Runtime**: llama.cpp `llama-server` (pinned release `b12588`, Vulkan build on
  Windows/Linux — it also holds the CPU backends incl. Zen 4 — Metal on Apple silicon),
  installed by `pnpm bootstrap` into `<data>/bin/llm/` (SHA-256 verified).
- **Lifecycle** (`llama.ts`): started lazily on the first request on a free loopback port
  with a random API key, one slot, reasoning off, `--cache-ram 0`; unloaded after 5 idle
  minutes, on shutdown, and before any other `ai`-class job (whisper, face tracking) runs
  (`exclusiveAi`), so two big models never share the 16 GB. A pid file lets the next boot
  kill an instance orphaned by a crash. If the Vulkan instance dies during load (driver
  problem, out of memory) it retries on the CPU.
- **Scheduling**: the three jobs are resource class `ai` (concurrency 1) and requests are
  additionally serialised in the port.
- **Constrained output**: every structured call sends a JSON Schema
  (`response_format: json_schema`), compiled to a grammar by llama.cpp. Segment ids are an
  `enum` of the real ids, so answers always map onto real cut points.
- **Missing model**: `available()` is false; `highlights` falls back to the heuristic ranker,
  `copywriter`/`emphasis` fail with a clear message and the UI disables them with a hint.

## Jobs

| kind         | payload                                      | result                                                         |
| ------------ | -------------------------------------------- | -------------------------------------------------------------- |
| `highlights` | `{ sources[{assetId,start?,end?}], target }` | variants (`story`, `punchy`, `chrono`) of moments with reasons |
| `copywriter` | `{ assetIds[], language?, vibe?, topic? }`   | `{ hooks[3], caption, hashtags[5–10] }`                        |
| `emphasis`   | `{ words[], language?, chapters? }`          | `{ marks[{index,emoji?}], chapters[{index,title}] }`           |

Highlights never shows the model timestamps: footage becomes numbered _segments_
(`segments.ts`) — sentences for speech (split at punctuation, pauses and ~12 s, trimmed of
filler, padded so cuts never clip a word), shots (scene cuts, chunked to ~3 s) for footage
without speech, one segment per photo. Visual stats from the thumbnail sprite (exposure,
contrast, detail, motion) rank non-speech shots and give the model words like "bright ·
detailed · fast motion". `highlights.ts` fits the ranking to the 15/30/60 s target, keeps
the hook ≤ 5 s, ends on a call to action when there is one, and builds three variants.

## Models and benchmarks

Reference host: ThinkPad T15, Ryzen 7 PRO 8840U, Radeon 780M (8 GB addressable of 16 GB
shared), Windows 11, llama.cpp b12588 Vulkan, Q4_K_M, context 8192. Tasks: the fixed
evaluation set in `test/ai/fixtures/llm-transcripts.ts` (4 transcripts of ~60 s in English,
Spanish, German; ground-truth hooks/filler/keywords), through the real pipeline.

| model (GGUF Q4_K_M) | license    | file   | load               | gen tok/s (Vulkan)                                                       | peak RAM   | hook hit | highlights (60 s talk)                                    | copy                                        |
| ------------------- | ---------- | ------ | ------------------ | ------------------------------------------------------------------------ | ---------- | -------- | --------------------------------------------------------- | ------------------------------------------- |
| **Qwen3.5 4B**      | Apache-2.0 | 2.7 GB | 5–10 s             | 6.1–7.7                                                                  | 3.7–4.0 GB | 4/4      | 36–48 s                                                   | 26–34 s                                     |
| Qwen3.5 2B          | Apache-2.0 | 1.3 GB | 5 s                | 14.8                                                                     | 1.9 GB     | 4/4      | 28 s                                                      | 13 s, one answer mixed Chinese into English |
| Gemma 4 E4B         | Apache-2.0 | 5.0 GB | 66 s (first, cold) | —                                                                        | 5.6 GB     | —        | failed: output cut off at the token budget (verbose JSON) | failed                                      |
| Qwen3.5 9B          | Apache-2.0 | 5.7 GB | —                  | ≈3 (not run end to end: leaves too little RAM for the editor and FFmpeg) | ≈7 GB      | —        | —                                                         | —                                           |

Raw throughput, `llama-bench`, Qwen3.5 4B Q4_K_M: Vulkan 155–165 prompt tok/s and 7.4–7.9
generation tok/s; CPU-only 47 prompt tok/s and 6.7 generation tok/s (the iGPU wins prompt
processing 3.4×, generation is memory-bandwidth bound on both). The end-to-end CPU run of the
same tasks took several minutes per call because the benchmark ran while other work loaded
the CPU; treat the CPU path as a fallback.

Quality on the evaluation set (Qwen3.5 4B): the chosen hook was one of the labelled hooks in
4/4 transcripts, no greeting/filler was picked in 4/4 after the segmenter's greeting
filter, hooks were ≤ 8 words in the right language, 10 hashtags each, and keyword
precision (words the model highlighted that are on the labelled list) was 0.64–1.0.

**Why Qwen3.5 4B is the default**: it is the best quality that stays responsive — about 40 s
for a 60 s talk's highlights and ~30 s for the copy, 4 GB peak so the editor, FFmpeg and
whisper keep working — with strong multilingual JSON. The 2B is twice as fast but drifts
languages and writes weaker copy; the 9B and Gemma 4 E4B (about 5 GB on disk, 5.6 GB RAM, and
too verbose for tight token budgets) do not fit the 16 GB shared-memory budget comfortably.
Gemma 4's mmproj/MTP drafter and Qwen3.6 (only 27B/35B so far) were not options.

## Switching models

```
pnpm bootstrap -- --llm-model qwen3.5-2b      # qwen3.5-4b (default) | qwen3.5-2b | qwen3.5-9b | none
```

The chosen file is recorded in `<data>/models/llm/default.json`. Any other GGUF dropped
into that folder works: set `REELFORGE_LLM_MODEL` to its file name (or an absolute path).
`REELFORGE_LLM_DEVICE=cpu` forces CPU inference.

## Tests

`test/ai/llm.test.ts` (unit: runtime discovery/argv, lifecycle with a fake child process —
lazy start, serialisation, GPU→CPU fallback, idle unload, abort — prompts, schemas, parsing,
fitting, jobs), `test/ai/llm.integration.test.ts` (real model, gated: skipped with a printed
reason without the runtime/model; override with `REELFORGE_LLM_TEST_SERVER` /
`REELFORGE_LLM_TEST_MODEL`).
