/** Matte job store + the UI state mapping of the Background section. */
import type { Asset, Job } from '@reelforge/core'
import { describe, expect, it, vi } from 'vitest'
import type { JobApi, JobDeps } from '@/editor/panels/ai/jobs.ts'
import { createMatteJobs } from '@/editor/panels/model/matteJobs.ts'
import { matteState } from '@/editor/panels/sections/BackgroundSection.tsx'
import { flushMicrotasks } from '../../fixtures.ts'
import { makeJob } from './helpers.ts'

type Listener = (e: { type: 'job'; job: Job }) => void

const harness = () => {
  const listeners = new Set<Listener>()
  const jobs = new Map<string, Job>()
  let n = 0
  const api = {
    createJob: vi.fn<JobApi['createJob']>((input) => {
      const job = makeJob({ id: `j${++n}`, kind: input.kind, status: 'running' })
      jobs.set(job.id, job)
      return Promise.resolve(job)
    }),
    job: vi.fn<JobApi['job']>((id: string) => Promise.resolve(jobs.get(id)!)),
    cancelJob: vi.fn<JobApi['cancelJob']>(() => Promise.resolve()),
  }
  const deps: JobDeps = {
    api,
    events: {
      on: (_t, cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
    pollMs: 1000,
  }
  const emit = (id: string, patch: Partial<Job>) => {
    const job = { ...jobs.get(id)!, ...patch }
    jobs.set(id, job)
    for (const l of listeners) l({ type: 'job', job })
  }
  return { api, deps, emit }
}

describe('matte jobs', () => {
  it('starts a matte job with the payload and follows progress to completion', async () => {
    const h = harness()
    const m = createMatteJobs(h.deps)
    m.start('a1', 'modnet', { projectId: 'p1' })
    await flushMicrotasks()
    expect(h.api.createJob).toHaveBeenCalledWith({
      kind: 'matte',
      assetId: 'a1',
      projectId: 'p1',
      payload: { assetId: 'a1', model: 'modnet' },
    })
    expect(m.store.getState().jobs.a1).toMatchObject({ status: 'running', progress: 0 })
    h.emit('j1', { progress: 0.4 })
    expect(m.store.getState().jobs.a1?.progress).toBeCloseTo(0.4)
    h.emit('j1', { status: 'done', progress: 1 })
    await flushMicrotasks()
    expect(m.store.getState().jobs.a1).toBeUndefined()
  })

  it('force is forwarded, and a failure is kept for display until dismissed', async () => {
    const h = harness()
    const m = createMatteJobs(h.deps)
    m.start('a1', 'modnet', { force: true })
    await flushMicrotasks()
    expect(h.api.createJob.mock.calls[0]?.[0].payload).toEqual({
      assetId: 'a1',
      model: 'modnet',
      force: true,
    })
    h.emit('j1', { status: 'failed', error: 'model missing' })
    await flushMicrotasks()
    expect(m.store.getState().jobs.a1).toMatchObject({ status: 'error', error: 'model missing' })
    m.dismiss('a1')
    expect(m.store.getState().jobs.a1).toBeUndefined()
  })

  it('cancel aborts the host job and clears the state; restart replaces the running one', async () => {
    const h = harness()
    const m = createMatteJobs(h.deps)
    m.start('a1', 'modnet')
    await flushMicrotasks()
    m.cancel('a1')
    await flushMicrotasks()
    expect(h.api.cancelJob).toHaveBeenCalledWith('j1')
    expect(m.store.getState().jobs.a1).toBeUndefined()
    m.start('a1', 'modnet')
    await flushMicrotasks()
    m.start('a1', 'modnet')
    await flushMicrotasks()
    expect(h.api.cancelJob).toHaveBeenCalledWith('j2')
    expect(m.store.getState().jobs.a1?.status).toBe('running')
  })
})

describe('matteState', () => {
  const asset = (matte?: Asset['matte']) => ({ id: 'a1', matte }) as Asset
  it('prefers a running job, then failures, then the cached matte', () => {
    expect(matteState(asset(), undefined)).toBe('none')
    expect(matteState(asset(), { status: 'running' })).toBe('running')
    expect(matteState(asset(), { status: 'error' })).toBe('failed')
    expect(
      matteState(asset({ status: 'processing', model: 'modnet', version: 0 }), undefined),
    ).toBe('running')
    expect(matteState(asset({ status: 'ready', model: 'modnet', version: 1 }), undefined)).toBe(
      'ready',
    )
    expect(matteState(asset({ status: 'failed', model: 'modnet', version: 0 }), undefined)).toBe(
      'failed',
    )
    // a fresh run over a ready matte shows as running
    expect(
      matteState(asset({ status: 'ready', model: 'modnet', version: 1 }), { status: 'running' }),
    ).toBe('running')
  })
})
