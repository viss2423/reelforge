import { describe, expect, it } from 'vitest'
import { aiJobs } from '../../src/ai/index.ts'
import { allJobDefinitions } from '../../src/jobs/registry.ts'
import { platformJobs } from '../../src/media/jobs.ts'
import { renderJobs } from '../../src/render/index.ts'

describe('job registry', () => {
  it('registers every platform, render and AI job kind exactly once', () => {
    const kinds = allJobDefinitions().map((d) => d.kind)
    expect(kinds.toSorted()).toEqual(
      [
        'probe',
        'proxy',
        'thumbnails',
        'waveform',
        'export',
        'preview',
        'transcribe',
        'silence',
        'beats',
        'scenes',
        'reframe',
      ].toSorted(),
    )
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('includes the render and AI definition objects themselves', () => {
    const defs = allJobDefinitions()
    for (const d of [...platformJobs, ...renderJobs, ...aiJobs]) expect(defs).toContain(d)
  })

  it('assigns every job a resource class and a numeric default priority', () => {
    for (const d of allJobDefinitions()) {
      expect(['io', 'cpu', 'gpu-encode', 'ai']).toContain(d.resource)
      expect(typeof d.defaultPriority).toBe('number')
    }
  })
})
