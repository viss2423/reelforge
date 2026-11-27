/**
 * AI job definitions, registered by the job queue:
 *
 * | kind       | resource | module               |
 * | ---------- | -------- | -------------------- |
 * | transcribe | ai       | transcribe/index.ts  |
 * | silence    | cpu      | silence.ts           |
 * | beats      | cpu      | beats/index.ts       |
 * | scenes     | cpu      | scenes.ts            |
 * | reframe    | ai       | reframe/index.ts     |
 * | matte      | ai       | matte/index.ts       |
 * | highlights | ai       | llm/jobs.ts          |
 * | copywriter | ai       | llm/jobs.ts          |
 * | emphasis   | ai       | llm/jobs.ts          |
 *
 * Every handler validates its payload, reports progress, honours `ctx.signal` (child
 * processes are killed, workers terminated) and cleans up its temp files. Benchmarks and
 * backend choices are documented in README.md next to this file.
 */
import type { JobDefinition } from '../contracts.ts'
import { beatsJob } from './beats/index.ts'
import { exclusiveAi, llmJobs } from './llm/index.ts'
import { matteJob } from './matte/index.ts'
import { reframeJob } from './reframe/index.ts'
import { scenesJob } from './scenes.ts'
import { silenceJob } from './silence.ts'
import { transcribeJob } from './transcribe/index.ts'

/** Non-LLM `ai`-class jobs unload the LLM first (see llm/index.ts). */
export const aiJobs: JobDefinition[] = [
  exclusiveAi(transcribeJob),
  silenceJob,
  beatsJob,
  scenesJob,
  exclusiveAi(reframeJob),
  exclusiveAi(matteJob),
  ...llmJobs,
]
