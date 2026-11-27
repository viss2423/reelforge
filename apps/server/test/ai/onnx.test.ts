/**
 * Shared ONNX session pool (lazy load, reuse, idle release, failure handling) and the
 * bootstrap manifest of the neural models. Gated on the YuNet model for the session tests.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_MODELS } from '../../../../scripts/lib/ai-models.ts'
import {
  cachedSessionCount,
  IDLE_MS,
  releaseIdleSessions,
  resolveProvider,
  withSession,
} from '../../src/ai/onnx.ts'
import { DATA_DIR, skipBecause } from './helpers.ts'

const YUNET = path.join(DATA_DIR, 'models', 'face', 'yunet.onnx')

afterEach(() => {
  vi.useRealTimers()
  releaseIdleSessions()
})

describe('provider resolution', () => {
  it('uses DirectML only on Windows', () => {
    expect(resolveProvider('cpu')).toBe('cpu')
    expect(resolveProvider('dml')).toBe(process.platform === 'win32' ? 'dml' : 'cpu')
  })
})

describe.skipIf(skipBecause(!existsSync(YUNET) && `YuNet model missing at ${YUNET}`))(
  'session pool',
  () => {
    it('shares one session between concurrent borrowers and releases it when idle', async () => {
      const seen: unknown[] = []
      await Promise.all([
        withSession(YUNET, { provider: 'cpu', threads: 1 }, async (s) => {
          seen.push(s)
        }),
        withSession(YUNET, { provider: 'cpu', threads: 1 }, async (s) => {
          seen.push(s)
        }),
      ])
      expect(seen[0]).toBe(seen[1])
      expect(cachedSessionCount()).toBe(1)
      releaseIdleSessions()
      expect(cachedSessionCount()).toBe(0)
    })

    it('keeps the session while a borrower is active and drops it after IDLE_MS', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await withSession(YUNET, { provider: 'cpu' }, async () => {
        releaseIdleSessions()
        expect(cachedSessionCount()).toBe(1)
      })
      expect(cachedSessionCount()).toBe(1)
      vi.advanceTimersByTime(IDLE_MS + 10)
      expect(cachedSessionCount()).toBe(0)
    })

    it('does not poison the cache with a failed load and propagates the error', async () => {
      const bad = path.join(DATA_DIR, 'models', 'face', 'does-not-exist.onnx')
      await expect(withSession(bad, { provider: 'cpu' }, async () => 1)).rejects.toBeDefined()
      expect(cachedSessionCount()).toBe(0)
    })
  },
)

describe('bootstrap manifest of the neural models', () => {
  it('pins every file: https URL on a commit, sha256, size and a models/ destination', () => {
    expect(AI_MODELS.map((m) => m.dest)).toEqual([
      'models/beats/beat_this_small0.onnx',
      'models/beats/beat_this_mel_filterbank.bin',
      'models/objects/dfine_s_coco.onnx',
      'models/saliency/u2netp.onnx',
    ])
    for (const m of AI_MODELS) {
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//)
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(m.size).toBeGreaterThan(1000)
    }
    expect(new Set(AI_MODELS.map((m) => m.id)).size).toBe(AI_MODELS.length)
  })
})
