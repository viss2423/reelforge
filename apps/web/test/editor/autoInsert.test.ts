import type { Asset } from '@reelforge/core'
import { describe, expect, it } from 'vitest'
import { planInsertions } from '@/editor/useAutoInsertUploads.ts'
import type { UploadTask } from '@/state/uploads.ts'
import { makeAsset } from '../fixtures.ts'

const task = (order: number, extra: Partial<UploadTask> = {}): UploadTask => ({
  id: `t${order}`,
  batchId: 'b1',
  order,
  name: `f${order}.mp4`,
  size: 1,
  mime: 'video/mp4',
  loaded: 0,
  status: 'done',
  projectId: 'p1',
  addToTimeline: true,
  inserted: false,
  asset: makeAsset({ id: `a${order}` }),
  ...extra,
})

const ids = (r: ReturnType<typeof planInsertions>) => ({
  insert: r.insert.map((x) => x.task.id),
  skip: r.skip.map((x) => x.id),
})

describe('planInsertions', () => {
  it('inserts finished uploads in pick order', () => {
    expect(ids(planInsertions([task(1), task(0)], 'p1', {}))).toEqual({
      insert: ['t0', 't1'],
      skip: [],
    })
  })

  it('waits for an earlier file that is still uploading', () => {
    const r = planInsertions(
      [task(0, { status: 'uploading', asset: undefined }), task(1)],
      'p1',
      {},
    )
    expect(ids(r)).toEqual({ insert: [], skip: [] })
  })

  it('waits until the host has probed the asset (duration known)', () => {
    const unprobed = task(0, { asset: makeAsset({ id: 'a0', duration: undefined }) })
    expect(ids(planInsertions([unprobed, task(1)], 'p1', {}))).toEqual({ insert: [], skip: [] })
    // The `asset` WS event updates the editor's map with the probed asset.
    const probed: Record<string, Asset> = { a0: makeAsset({ id: 'a0' }) }
    const r = planInsertions([unprobed, task(1)], 'p1', probed)
    expect(ids(r)).toEqual({ insert: ['t0', 't1'], skip: [] })
    expect(r.insert[0]?.asset).toBe(probed.a0)
  })

  it('skips failed/cancelled uploads and unreadable media without blocking the rest', () => {
    const r = planInsertions(
      [
        task(0, { status: 'error', asset: undefined }),
        task(1, { status: 'cancelled', asset: undefined }),
        task(2, { asset: makeAsset({ id: 'bad', duration: undefined, proxy: 'failed' }) }),
        task(3),
      ],
      'p1',
      {},
    )
    expect(ids(r)).toEqual({ insert: ['t3'], skip: ['t2'] })
  })

  it('ignores tasks for other projects, library-only uploads and inserted ones', () => {
    const r = planInsertions(
      [
        task(0, { projectId: 'other' }),
        task(1, { addToTimeline: false }),
        task(2, { inserted: true }),
        task(3),
      ],
      'p1',
      {},
    )
    expect(ids(r).insert).toEqual(['t3'])
  })

  it('orders batches independently', () => {
    const r = planInsertions(
      [
        task(0, { batchId: 'A', status: 'uploading', asset: undefined }),
        task(0, { id: 'b0', batchId: 'B' }),
      ],
      'p1',
      {},
    )
    expect(ids(r).insert).toEqual(['b0'])
  })
})
