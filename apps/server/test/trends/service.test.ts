import { describe, expect, it } from 'vitest'
import { trendsConfig } from '../../src/config.ts'
import { EventBus } from '../../src/jobs/events.ts'
import { PacksService } from '../../src/packs/service.ts'
import { noLlm, type LlmPort } from '../../src/trends/llm-port.ts'
import { PoliteHttp } from '../../src/trends/http.ts'
import {
  TrendsService,
  trendsJob,
  type TrendsConfig,
  type TrendsSettings,
} from '../../src/trends/service.ts'
import type { Exec } from '../../src/trends/publish.ts'
import { repoFromRemote } from '../../src/trends/publish.ts'
import type { ServerEvent } from '@reelforge/core'
import { log, makeQueue, waitFor } from '../helpers.ts'
import { makeApp } from '../http/harness.ts'
import { BUNDLED, fakeLlm, fixtureFetch } from './helpers.ts'
import { SoundPreviews } from '../../src/trends/sounds.ts'

const CONFIG: TrendsConfig = {
  enabled: true,
  region: 'US',
  hour: 4,
  youtubeKey: 'k',
  redditId: 'a',
  redditSecret: 'b',
  publish: undefined,
  publishMode: 'pr',
  publishRepo: 'owner/repo',
}

const setup = async (
  over: { llm?: LlmPort; config?: Partial<TrendsConfig>; exec?: Exec; now?: Date } = {},
) => {
  const q = await makeQueue([])
  const bus = new EventBus()
  const events: ServerEvent[] = []
  bus.subscribe((e) => events.push(e))
  const packs = new PacksService({
    root: q.paths.packs,
    bundledDir: BUNDLED,
    url: 'http://127.0.0.1:9/packs',
    appVersion: '0.1.0',
    log,
    bus,
  })
  await packs.init()
  let settings: TrendsSettings | undefined
  const fetch = fixtureFetch()
  const clock = { now: over.now ?? new Date('2026-11-20T12:00:00') }
  const make = () =>
    new TrendsService({
      dataRoot: q.paths.root,
      packs,
      config: { ...CONFIG, ...over.config },
      llm: over.llm ?? fakeLlm(),
      log,
      ffmpeg: 'ffmpeg',
      userAgent: 'test',
      settings: { get: () => settings, set: (v) => (settings = v) },
      fetch,
      http: new PoliteHttp({
        cacheDir: `${q.paths.root}/trends/cache`,
        userAgent: 'test',
        fetch,
        hostGapMs: 0,
      }),
      clock: () => clock.now,
      skipThumbs: true,
      ...(over.exec ? { exec: over.exec } : {}),
    })
  const service = make()
  await service.init()
  return { ...q, packs, service, events, clock, make }
}

describe('TrendsService', () => {
  it('refresh: signals → ranked packs → live pack overlay → ideas, persisted', async () => {
    const t = await setup()
    try {
      const state = await t.service.refresh()
      expect(state.sources.map((s) => [s.id, s.state])).toEqual([
        ['google-trends', 'ok'],
        ['wikipedia', 'ok'],
        ['apple-music', 'ok'],
        ['deezer', 'ok'],
        ['youtube', 'ok'],
        ['reddit', 'ok'],
      ])
      const snap = t.packs.snapshot
      const live = snap.manifests.find((m) => m.id === 'trending-live')
      expect(live?.templates.length).toBeGreaterThan(0)
      expect(snap.index?.packs.at(-1)?.id).toBe('trending-live')
      expect(snap.index?.version).toMatch(/-live\./)
      expect(t.events.some((e) => e.type === 'packs')).toBe(true)
      // Ranked: served scores differ from shipped ones for at least some items.
      const shipped = t.packs.base.manifests.find((m) => m.id === 'trending-2026-11')!
      const served = snap.manifests.find((m) => m.id === 'trending-2026-11')!
      expect(
        served.templates.some((x, i) => x.trendScore !== shipped.templates[i]!.trendScore),
      ).toBe(true)
      // Files of the live pack are served through the packs file resolver.
      const lut = live!.filters[0]!.lut
      expect(t.packs.resolveFile(`trending-live/${lut}`)).toContain('trending-live')
      const sum = t.service.summary()
      expect(sum.stale).toBe(false)
      expect(sum.items.length).toBeGreaterThan(0)
      expect(sum.items.every((i) => i.fresh)).toBe(true)
      expect(sum.items.find((i) => i.ref === 'trending-live/snow-day-dump')?.trend).toBe(
        'photo dump',
      )
      expect(sum.sounds[0]!.link).toMatch(/^https:\/\/www\.deezer\.com\/search\//)
      expect(sum.topics.length).toBeGreaterThan(5)
      expect(sum.ideas.length).toBe(8)
      expect(sum.llm.used).toBe(true)
      expect(sum.hashtags).toContain('winterphotodump')

      // Restart: state and overlay come back from disk.
      const again = t.make()
      t.packs.setOverlay({}, false)
      await again.init()
      expect(t.packs.snapshot.manifests.some((m) => m.id === 'trending-live')).toBe(true)
      expect(again.summary().generatedAt).toBe(sum.generatedAt)
    } finally {
      await t.cleanup()
    }
  })

  it('works without an LLM: ranking + beat remixes + template-based ideas', async () => {
    const t = await setup({ llm: noLlm })
    try {
      const state = await t.service.refresh()
      expect(state.llm.used).toBe(false)
      const live = t.packs.snapshot.manifests.find((m) => m.id === 'trending-live')!
      expect(live.templates.length).toBeGreaterThan(0)
      for (const tpl of live.templates) expect(tpl.musicHint?.bpm).toBeGreaterThan(0)
      expect(state.ideas.length).toBeGreaterThan(0)
      expect(state.ideas[0]!.hooks).toHaveLength(3)
    } finally {
      await t.cleanup()
    }
  })

  it('records a total outage without losing the previous pack', async () => {
    const t = await setup()
    try {
      await t.service.refresh()
      const before = t.packs.snapshot.index?.version
      const broken = new TrendsService({
        dataRoot: t.paths.root,
        packs: t.packs,
        config: { ...CONFIG, youtubeKey: undefined, redditId: undefined },
        llm: noLlm,
        log,
        ffmpeg: 'ffmpeg',
        userAgent: 'test',
        settings: { get: () => undefined, set: () => {} },
        http: new PoliteHttp({
          cacheDir: `${t.paths.root}/empty-cache`,
          userAgent: 'test',
          fetch: (async () => new Response('', { status: 500 })) as typeof fetch,
          retries: 0,
          hostGapMs: 0,
        }),
        skipThumbs: true,
      })
      await broken.init()
      await expect(broken.refresh()).rejects.toThrow(/no trend source/)
      expect(broken.summary().lastError).toMatch(/no trend source/)
      expect(t.packs.snapshot.index?.version).toBe(before)
    } finally {
      await t.cleanup()
    }
  })

  it('scheduling: stale at startup, daily at the quiet hour, never while busy', async () => {
    const t = await setup()
    try {
      t.service.start(t.queue, { schedule: false })
      expect(t.service.stale()).toBe(true)
      expect(t.service.shouldRun(new Date('2026-11-20T12:00:00'))).toBe(true)
      await t.service.refresh()
      expect(t.service.shouldRun(new Date('2026-11-20T13:00:00'))).toBe(false) // fresh
      expect(t.service.shouldRun(new Date('2026-11-21T04:10:00'))).toBe(true) // quiet hour, next day
      expect(t.service.shouldRun(new Date('2026-11-21T05:10:00'))).toBe(false)
      expect(t.service.nextRunAt(new Date('2026-11-20T13:00:00'))).toBe(
        new Date('2026-11-21T04:00:00').toISOString(),
      )
      // Busy: an export queued → wait.
      const block = new Promise<void>(() => {})
      const busy = await makeQueue([
        { kind: 'export', resource: 'gpu-encode', defaultPriority: 1, handler: () => block },
      ])
      busy.queue.start()
      busy.queue.enqueue('export', {})
      t.service.start(busy.queue, { schedule: false })
      await waitFor(() => busy.queue.stats()['gpu-encode'].running === 1)
      expect(t.service.shouldRun(new Date('2026-11-25T04:10:00'))).toBe(false)
      await busy.cleanup()
    } finally {
      await t.cleanup()
    }
  })

  it('runs as a low-priority AI job; concurrent refreshes share one run', async () => {
    const t = await setup()
    const q = await makeQueue([trendsJob(() => t.service)])
    try {
      q.queue.start()
      t.service.start(q.queue, { schedule: false })
      const id = t.service.enqueue()!
      expect(t.service.enqueue()).toBe(id)
      await q.queue.idle()
      const job = q.store.getJob(id)!
      expect(job.status).toBe('done')
      expect(job.kind).toBe('trends')
      const a = t.service.refresh()
      const b = t.service.refresh()
      expect(a).toBe(b)
      await a
    } finally {
      await q.cleanup()
      await t.cleanup()
    }
  })

  it('auto-publishes through gh when enabled (PR mode, never forced)', async () => {
    const calls: string[][] = []
    const bodies: unknown[] = []
    const exec: Exec = async (_cmd, args, input) => {
      calls.push([...args])
      if (input) bodies.push(JSON.parse(input))
      const route = args[3] ?? ''
      const out = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' })
      if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'pr' && args[1] === 'list') return out([])
      if (args[0] === 'pr')
        return { code: 0, stdout: 'https://github.com/owner/repo/pull/7\n', stderr: '' }
      if (route.endsWith('git/ref/heads/trends')) return { code: 1, stdout: '', stderr: '404' }
      if (route.endsWith('git/ref/heads/main')) return out({ object: { sha: 'main-sha' } })
      if (route.includes('git/commits/')) return out({ tree: { sha: 'tree-sha' } })
      if (route.includes('git/trees/tree-sha'))
        return out({ tree: [{ path: 'packs/trending-live/old.webp', type: 'blob' }] })
      if (route.endsWith('git/blobs')) return out({ sha: `blob-${bodies.length}` })
      if (route.endsWith('git/trees')) return out({ sha: 'new-tree' })
      if (route.endsWith('git/commits')) return out({ sha: 'new-commit' })
      return out({})
    }
    const t = await setup({ config: { publish: 'github' }, exec })
    try {
      expect(t.service.settings()).toEqual({ autoPublish: true })
      await t.service.refresh()
      expect(t.service.summary().publish).toMatchObject({
        status: 'published (pr)',
        url: 'https://github.com/owner/repo/pull/7',
      })
      const patch = bodies.find((b) => (b as { force?: boolean }).force !== undefined)
      expect(patch).toEqual({ sha: 'new-commit', force: false })
      const tree = bodies.find((b) => (b as { base_tree?: string }).base_tree) as {
        tree: Array<{ path: string; sha: string | null }>
      }
      expect(tree.tree.find((e) => e.path === 'packs/trending-live/old.webp')?.sha).toBeNull()
      expect(tree.tree.some((e) => e.path === 'packs/trending-live/pack.json')).toBe(true)
      // Turning the toggle off stops publishing.
      t.service.setSettings({ autoPublish: false })
      const before = calls.length
      t.clock.now = new Date('2026-11-21T12:00:00')
      await t.service.refresh()
      expect(calls.length).toBe(before)
    } finally {
      await t.cleanup()
    }
  })

  it('config parsing', () => {
    const c = trendsConfig(
      { TRENDS_HOUR: '3', PUBLISH_TRENDS: 'github' },
      'https://raw.githubusercontent.com/me/rf/main/packs',
    )
    expect(c).toMatchObject({
      hour: 3,
      publish: 'github',
      publishMode: 'pr',
      publishRepo: 'me/rf',
      enabled: true,
    })
    expect(() => trendsConfig({ TRENDS_HOUR: '25' }, '')).toThrow(/TRENDS_HOUR/)
    expect(() => trendsConfig({ PUBLISH_TRENDS_MODE: 'force' }, '')).toThrow(/PUBLISH_TRENDS_MODE/)
    expect(repoFromRemote('git@github.com:viss2423/reelforge.git')).toBe('viss2423/reelforge')
  })
})

describe('trend routes', () => {
  it('GET /api/trends, POST refresh/ideas, PUT settings', async () => {
    const h = await makeApp({ bundledPacks: BUNDLED })
    const t = await setup()
    try {
      // The harness app has no trend engine (503 below); build one with it attached.
      const { buildApp } = await import('../../src/http/app.ts')
      const app = await buildApp({
        version: '0.1.0',
        webDist: undefined,
        paths: h.paths,
        tools: (await import('../helpers.ts')).fakeToolchain(),
        store: h.store,
        queue: t.queue,
        bus: h.bus,
        uploads: h.uploads,
        auth: h.auth,
        packs: t.packs,
        trends: t.service,
        log,
        urls: () => [],
      })
      t.service.start(t.queue, { schedule: false })
      const get = await app.inject({ method: 'GET', url: '/api/trends', headers: h.headers })
      expect(get.statusCode).toBe(200)
      expect(get.json()).toMatchObject({ enabled: true, stale: true, generatedAt: null })
      const idea = await app.inject({
        method: 'POST',
        url: '/api/trends/ideas',
        headers: h.headers,
        payload: { topic: 'Snow day' },
      })
      expect(idea.statusCode).toBe(200)
      expect(idea.json().topic).toBe('snow day')
      const bad = await app.inject({
        method: 'POST',
        url: '/api/trends/ideas',
        headers: h.headers,
        payload: {},
      })
      expect(bad.statusCode).toBe(400)
      const put = await app.inject({
        method: 'PUT',
        url: '/api/trends/settings',
        headers: h.headers,
        payload: { autoPublish: true },
      })
      expect(put.json()).toEqual({ autoPublish: true })
      // Synced trending-sound previews are opt-in (TRENDS_SOUND_PREVIEW=1).
      const info = await app.inject({
        method: 'GET',
        url: '/api/trends/sounds/preview-info?title=Known',
        headers: h.headers,
      })
      expect(info.json()).toEqual({ available: false, disabled: true })
      const audio = await app.inject({
        method: 'GET',
        url: '/api/trends/sounds/preview?title=Known',
        headers: h.headers,
      })
      expect(audio.statusCode).toBe(403)
      const unauth = await app.inject({ method: 'GET', url: '/api/trends' })
      expect(unauth.statusCode).toBe(401)
      const missing = await h.app.inject({ method: 'GET', url: '/api/trends', headers: h.headers })
      expect(missing.statusCode).toBe(503)
      await app.close()
    } finally {
      await t.cleanup()
      await h.cleanup()
    }
  })
})

describe('trending sound preview routes', () => {
  it('streams the official preview without storing it, and 404s when there is none', async () => {
    const h = await makeApp({ bundledPacks: BUNDLED })
    const t = await setup({ config: { soundPreview: true } })
    try {
      const mp3 = new Uint8Array([0xff, 0xfb, 9, 9, 9])
      const fetch = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.startsWith('https://api.deezer.com/search'))
          return Response.json(
            url.includes('Known')
              ? {
                  data: [
                    {
                      title: 'Known',
                      preview: 'https://cdnt-preview.dzcdn.net/k.mp3',
                      artist: { name: 'Band' },
                    },
                  ],
                }
              : { data: [] },
          )
        if (url === 'https://cdnt-preview.dzcdn.net/k.mp3')
          return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } })
        return new Response('', { status: 404 })
      }) as typeof globalThis.fetch
      ;(t.service as unknown as { previews: SoundPreviews }).previews = new SoundPreviews({
        userAgent: 'test',
        fetch,
      })
      const { buildApp } = await import('../../src/http/app.ts')
      const app = await buildApp({
        version: '0.1.0',
        webDist: undefined,
        paths: h.paths,
        tools: (await import('../helpers.ts')).fakeToolchain(),
        store: h.store,
        queue: t.queue,
        bus: h.bus,
        uploads: h.uploads,
        auth: h.auth,
        packs: t.packs,
        trends: t.service,
        log,
        urls: () => [],
      })
      const info = await app.inject({
        method: 'GET',
        url: '/api/trends/sounds/preview-info?title=Known&artist=Band',
        headers: h.headers,
      })
      expect(info.json()).toEqual({ available: true, source: 'deezer', duration: 30 })
      const audio = await app.inject({
        method: 'GET',
        url: '/api/trends/sounds/preview?title=Known&artist=Band',
        headers: h.headers,
      })
      expect(audio.statusCode).toBe(200)
      expect(audio.headers['content-type']).toBe('audio/mpeg')
      expect(audio.headers['cache-control']).toBe('no-store')
      expect(new Uint8Array(audio.rawPayload)).toEqual(mp3)
      const none = await app.inject({
        method: 'GET',
        url: '/api/trends/sounds/preview?title=Unknown',
        headers: h.headers,
      })
      expect(none.statusCode).toBe(404)
      const grid = await app.inject({
        method: 'POST',
        url: '/api/trends/sounds/beats',
        headers: h.headers,
        payload: { title: 'Unknown', bpm: 100 },
      })
      expect(grid.json()).toMatchObject({ engine: 'grid', bpm: 100 })
      await app.close()
    } finally {
      await t.cleanup()
      await h.cleanup()
    }
  })
})
