/**
 * Local LLM module: `createLlm(deps)` (the LlmPort other modules use), the LLM jobs, and a
 * shared instance per data directory so the model stays loaded between consecutive
 * requests and unloads after five idle minutes. See README.md for models and benchmarks.
 */
import path from 'node:path'
import type { DataPaths, JobContext, JobDefinition, Logger } from '../../contracts.ts'
import { createLlmJobs } from './jobs.ts'
import { createLlm, type ManagedLlm } from './port.ts'
import { findLlmInstall } from './runtime.ts'

export { createLlm, type LlmDeps, type ManagedLlm } from './port.ts'
export { LlmUnavailableError, type LlmPort, type LlmRequest, type LlmResult } from './types.ts'
export { createLlmJobs, type LlmResolver } from './jobs.ts'

const shared = new Map<string, ManagedLlm>()

/** The process-wide LLM for a data directory (created on first use, never loads eagerly). */
export const sharedLlm = (
  paths: Pick<DataPaths, 'root' | 'bin' | 'models' | 'tmp'>,
  log?: Logger,
): ManagedLlm => {
  const key = path.resolve(paths.root)
  let llm = shared.get(key)
  if (!llm) {
    llm = createLlm({ paths, ...(log ? { log } : {}) })
    shared.set(key, llm)
  }
  return llm
}

/** Unloads every shared LLM (server shutdown). */
export const shutdownLlms = async (): Promise<void> => {
  await Promise.all([...shared.values()].map((l) => l.unload().catch(() => undefined)))
}

/** Installed model summary for `/api/system` (no model load). */
export const llmStatus = (
  paths: Pick<DataPaths, 'bin' | 'models'>,
): { installed: boolean; model: string | null } => {
  const i = findLlmInstall(paths)
  return { installed: i !== undefined, model: i ? path.basename(i.model) : null }
}

const sharedFor = (ctx: JobContext): ManagedLlm => sharedLlm(ctx.paths, ctx.log)

/** The LLM jobs bound to the shared instance. */
export const llmJobs: JobDefinition[] = createLlmJobs(sharedFor)

/**
 * Wraps another `ai`-class job (whisper, face tracking, segmentation …) so the LLM is
 * unloaded before it runs: two large models never share the 16 GB of unified memory.
 */
export const exclusiveAi = (def: JobDefinition): JobDefinition => ({
  ...def,
  handler: async (ctx) => {
    await shared.get(path.resolve(ctx.paths.root))?.unload()
    return def.handler(ctx)
  },
})
