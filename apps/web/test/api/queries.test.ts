import type { Asset, Job } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client.ts'
import {
  applyServerEvent,
  createQueryClient,
  isActiveJob,
  qk,
  refetchAfterReconnect,
  selectExports,
  upsertById,
} from '@/api/queries.ts'
import { makeAsset } from '../fixtures.ts'

const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  kind: 'export',
  status: 'running',
  progress: 0,
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
})

describe('upsertById', () => {
  it('replaces in place, prepends new items and leaves undefined lists alone', () => {
    const list = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
    ]
    expect(upsertById(list, { id: 'b', v: 2 })).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ])
    expect(upsertById(list, { id: 'c', v: 1 })?.map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(list[1]?.v).toBe(1) // not mutated
    expect(upsertById(undefined, { id: 'x' })).toBeUndefined()
  })
})

describe('applyServerEvent', () => {
  it('folds job and asset events into cached lists', () => {
    const qc = createQueryClient()
    qc.setQueryData<Job[]>(qk.jobs, [job('j1')])
    qc.setQueryData<Asset[]>(qk.assets, [])
    applyServerEvent(qc, { type: 'job', job: job('j1', { progress: 0.5 }) })
    applyServerEvent(qc, { type: 'job', job: job('j2') })
    const asset = makeAsset({ id: 'a1' })
    applyServerEvent(qc, { type: 'asset', asset })
    expect(qc.getQueryData<Job[]>(qk.jobs)?.map((j) => [j.id, j.progress])).toEqual([
      ['j2', 0],
      ['j1', 0.5],
    ])
    expect(qc.getQueryData<Asset[]>(qk.assets)).toEqual([asset])
  })

  it('does not create lists that were never fetched', () => {
    const qc = createQueryClient()
    applyServerEvent(qc, { type: 'job', job: job('j1') })
    expect(qc.getQueryData(qk.jobs)).toBeUndefined()
  })

  it('invalidates projects and packs on their events', () => {
    const qc = createQueryClient()
    qc.setQueryData(qk.projects, [])
    qc.setQueryData(qk.packs, {})
    applyServerEvent(qc, { type: 'project', projectId: 'p', revision: 2, origin: 'd' })
    applyServerEvent(qc, { type: 'packs', version: '2' })
    applyServerEvent(qc, { type: 'hello', serverVersion: '1', deviceId: 'd' })
    expect(qc.getQueryState(qk.projects)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(qk.packs)?.isInvalidated).toBe(true)
  })

  it('refetchAfterReconnect invalidates every event-driven list', () => {
    const qc = createQueryClient()
    for (const k of [qk.jobs, qk.assets, qk.projects]) qc.setQueryData(k, [])
    refetchAfterReconnect(qc)
    for (const k of [qk.jobs, qk.assets, qk.projects])
      expect(qc.getQueryState(k)?.isInvalidated).toBe(true)
  })
})

describe('helpers', () => {
  it('selectExports keeps export jobs newest first', () => {
    const list = [
      job('old', { createdAt: '2026-01-01' }),
      job('t', { kind: 'transcribe' }),
      job('new', { createdAt: '2026-02-01' }),
    ]
    expect(selectExports(list).map((j) => j.id)).toEqual(['new', 'old'])
  })

  it('isActiveJob', () => {
    expect(isActiveJob(job('a', { status: 'queued' }))).toBe(true)
    expect(isActiveJob(job('a', { status: 'running' }))).toBe(true)
    expect(isActiveJob(job('a', { status: 'done' }))).toBe(false)
  })

  it('only retries transient failures', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry as (
      n: number,
      e: unknown,
    ) => boolean
    expect(retry(0, new ApiError(503, 'x'))).toBe(true)
    expect(retry(0, new ApiError(401, 'x'))).toBe(false)
    expect(retry(2, new ApiError(503, 'x'))).toBe(false)
    expect(retry(0, new TypeError('x'))).toBe(true)
  })
})
