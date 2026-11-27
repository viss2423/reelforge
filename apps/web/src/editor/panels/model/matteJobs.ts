/**
 * Host `matte` jobs (AI subject separation) per asset, outside React: the job keeps running
 * when the Background sheet closes, and every clip of the same asset shows its progress.
 * The finished matte arrives on the asset (WebSocket `asset` event → editor store).
 */
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { api, events } from '@/api/index.ts'
import { isAbortError } from '@/lib/backoff.ts'
import { runJob, type JobDeps } from '../ai/jobs.ts'

export type MatteModel = 'modnet'

export interface MatteJobState {
  model: MatteModel
  /** 0..1 */
  progress: number
  status: 'running' | 'error'
  error?: string
}

export interface MatteJobs {
  store: StoreApi<{ jobs: Readonly<Record<string, MatteJobState>> }>
  /** Start (or restart with another model) the matte job of an asset. */
  start(assetId: string, model: MatteModel, opts?: { projectId?: string; force?: boolean }): void
  cancel(assetId: string): void
  dismiss(assetId: string): void
}

export const createMatteJobs = (deps: JobDeps): MatteJobs => {
  const store = createStore<{ jobs: Readonly<Record<string, MatteJobState>> }>()(() => ({
    jobs: {},
  }))
  const controllers = new Map<string, AbortController>()
  const set = (assetId: string, s: MatteJobState | null) =>
    store.setState((st) => {
      const jobs = { ...st.jobs }
      if (s) jobs[assetId] = s
      else delete jobs[assetId]
      return { jobs }
    })

  const cancel = (assetId: string) => {
    controllers.get(assetId)?.abort()
    controllers.delete(assetId)
    set(assetId, null)
  }

  return {
    store,
    start(assetId, model, opts = {}) {
      cancel(assetId)
      const controller = new AbortController()
      controllers.set(assetId, controller)
      set(assetId, { model, progress: 0, status: 'running' })
      runJob(
        deps,
        {
          kind: 'matte',
          assetId,
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          payload: { assetId, model, ...(opts.force ? { force: true } : {}) },
        },
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (controllers.get(assetId) === controller)
              set(assetId, { model, progress: p, status: 'running' })
          },
        },
      ).then(
        () => {
          if (controllers.get(assetId) !== controller) return
          controllers.delete(assetId)
          set(assetId, null)
        },
        (err: unknown) => {
          if (isAbortError(err) || controllers.get(assetId) !== controller) return
          controllers.delete(assetId)
          set(assetId, {
            model,
            progress: 0,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          })
        },
      )
    },
    cancel,
    dismiss: (assetId) => set(assetId, null),
  }
}

export const matteJobs: MatteJobs = createMatteJobs({ api, events })

/** The running/failed matte job of an asset (undefined when idle). */
export const useMatteJob = (
  assetId: string,
  jobs: MatteJobs = matteJobs,
): MatteJobState | undefined => useStore(jobs.store, (s) => s.jobs[assetId])
