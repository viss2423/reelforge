/**
 * The complete set of job handlers: platform media jobs (this package), render jobs
 * (src/render) and AI jobs (src/ai). Kinds must be unique across all three.
 */
import type { JobDefinition } from '../contracts.ts'
import { aiJobs } from '../ai/index.ts'
import { platformJobs } from '../media/jobs.ts'
import { musicJobs } from '../music/index.ts'
import { renderJobs } from '../render/index.ts'

/** Merges definition lists, rejecting duplicate kinds (a wiring bug, caught at boot). */
export const mergeDefinitions = (
  ...lists: ReadonlyArray<readonly JobDefinition[]>
): JobDefinition[] => {
  const seen = new Set<string>()
  const out: JobDefinition[] = []
  for (const def of lists.flat()) {
    if (seen.has(def.kind)) throw new Error(`duplicate job definition: ${def.kind}`)
    seen.add(def.kind)
    out.push(def)
  }
  return out
}

/** Every job definition the server can run. */
export const allJobDefinitions = (): JobDefinition[] =>
  mergeDefinitions(platformJobs, renderJobs, aiJobs, musicJobs)
