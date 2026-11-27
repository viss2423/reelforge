import { describe, expect, it } from 'vitest'
import { HttpError, PoliteHttp, retryAfterMs } from '../../src/trends/http.ts'
import { tempDir } from '../helpers.ts'

const signal = new AbortController().signal

const scripted = (responses: Array<() => Response>, seen: RequestInit[] = []): typeof fetch => {
  let i = 0
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {})
    const r = responses[Math.min(i++, responses.length - 1)]!
    return r()
  }) as typeof fetch
}

const setup = async (fetchImpl: typeof fetch, now = { t: 1_000_000 }) => {
  const { dir, cleanup } = await tempDir('rf-trends-http-')
  const sleeps: number[] = []
  const http = new PoliteHttp({
    cacheDir: dir,
    userAgent: 'ReelForge test',
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms)
      now.t += ms
    },
    clock: () => now.t,
  })
  return { http, sleeps, now, cleanup }
}

describe('PoliteHttp', () => {
  it('serves from cache within the TTL and revalidates with ETag after it', async () => {
    const seen: RequestInit[] = []
    const f = scripted(
      [
        () => new Response('v1', { headers: { etag: '"a"' } }),
        () => new Response(null, { status: 304 }),
      ],
      seen,
    )
    const { http, now, cleanup } = await setup(f)
    try {
      expect(await http.get('https://x.test/a', { signal, ttlMs: 60_000 })).toBe('v1')
      expect(await http.get('https://x.test/a', { signal, ttlMs: 60_000 })).toBe('v1')
      expect(http.requests).toBe(1)
      now.t += 61_000
      expect(await http.get('https://x.test/a', { signal, ttlMs: 60_000 })).toBe('v1')
      expect(http.requests).toBe(2)
      expect((seen[1]!.headers as Record<string, string>)['if-none-match']).toBe('"a"')
      expect((seen[0]!.headers as Record<string, string>)['user-agent']).toBe('ReelForge test')
    } finally {
      await cleanup()
    }
  })

  it('backs off on 429 honouring Retry-After, then succeeds', async () => {
    const f = scripted([
      () => new Response('', { status: 429, headers: { 'retry-after': '7' } }),
      () => new Response('', { status: 503 }),
      () => new Response('ok'),
    ])
    const { http, sleeps, cleanup } = await setup(f)
    try {
      expect(await http.get('https://x.test/b', { signal })).toBe('ok')
      expect(sleeps).toContain(7_000)
      expect(sleeps).toContain(2_000) // second attempt: exponential 1 s × 2
    } finally {
      await cleanup()
    }
  })

  it('does not retry client errors and falls back to a stale copy', async () => {
    const f = scripted([() => new Response('old'), () => new Response('', { status: 403 })])
    const { http, now, cleanup } = await setup(f)
    try {
      expect(await http.get('https://x.test/c', { signal, ttlMs: 10 })).toBe('old')
      now.t += 1_000
      expect(await http.get('https://x.test/c', { signal, ttlMs: 10 })).toBe('old')
      expect(http.requests).toBe(2)
      await expect(http.get('https://x.test/other', { signal })).rejects.toBeInstanceOf(HttpError)
    } finally {
      await cleanup()
    }
  })

  it('spaces requests to the same host', async () => {
    const f = scripted([() => new Response('x')])
    const { http, sleeps, cleanup } = await setup(f, { t: 5_000_000 })
    try {
      await http.get('https://h.test/1', { signal })
      await http.get('https://h.test/2', { signal })
      await http.get('https://other.test/3', { signal })
      expect(sleeps).toEqual([1_000])
    } finally {
      await cleanup()
    }
  })

  it('parses Retry-After dates and caps waits', () => {
    expect(retryAfterMs('120', 0)).toBe(60_000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000)
    expect(retryAfterMs(null, 0)).toBeUndefined()
  })
})
