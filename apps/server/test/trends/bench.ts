/**
 * Trend engine benchmark: one full refresh against the LIVE keyless sources with real
 * FFmpeg thumbnails, in a temp data dir. The LLM is the fake port (generation cost of a
 * real model is the LLM module's to measure), so this times everything the engine owns.
 *
 *   node apps/server/test/trends/bench.ts [--offline]
 *
 * `--offline` serves the recorded fixtures instead of the network.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { silentLogger } from '../../src/logger.ts'
import { PacksService } from '../../src/packs/service.ts'
import { detectToolchain } from '../../src/toolchain.ts'
import { dataPaths, ensureDataPaths } from '../../src/config.ts'
import { TrendsService } from '../../src/trends/service.ts'
import { BUNDLED, fakeLlm, fixtureFetch } from './helpers.ts'

const offline = process.argv.includes('--offline')
const dir = await mkdtemp(path.join(os.tmpdir(), 'rf-trends-bench-'))
const log = silentLogger()
try {
  const paths = dataPaths(dir)
  await ensureDataPaths(paths)
  const tools = await detectToolchain({ paths, log, skipEncoderProbe: true })
  const packs = new PacksService({
    root: paths.packs,
    bundledDir: BUNDLED,
    url: 'http://127.0.0.1:9',
    appVersion: '0.1.0',
    log,
  })
  await packs.init()
  const service = new TrendsService({
    dataRoot: dir,
    packs,
    config: { enabled: true, region: 'US', hour: 4, publish: undefined, publishMode: 'pr' },
    llm: fakeLlm(),
    log,
    ffmpeg: tools.ffmpeg,
    userAgent: 'ReelForge benchmark (self-hosted trend engine)',
    settings: { get: () => undefined, set: () => {} },
    ...(offline ? { fetch: fixtureFetch() } : {}),
  })
  await service.init()
  const rss0 = process.memoryUsage().rss
  let peak = rss0
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50)
  const t0 = performance.now()
  const state = await service.refresh()
  const cold = performance.now() - t0
  const t1 = performance.now()
  await service.refresh() // warm: sources served from the HTTP cache
  const warm = performance.now() - t1
  clearInterval(sampler)
  const live = packs.snapshot.manifests.find((m) => m.id === 'trending-live')!
  const out = {
    mode: offline ? 'offline fixtures' : 'live network',
    sources: state.sources.map((s) => `${s.id}:${s.state}:${s.items}${s.ms ? `@${s.ms}ms` : ''}`),
    signals: state.signals.length,
    stagesMs: state.ms,
    coldMs: Math.round(cold),
    warmMs: Math.round(warm),
    liveItems: {
      templates: live.templates.length,
      textPresets: live.textPresets.length,
      captionStyles: live.captionStyles.length,
      files: live.files.length,
      bytes: live.files.reduce((n, f) => n + f.size, 0),
    },
    dropped: state.dropped.length,
    rssMB: { before: Math.round(rss0 / 1048576), peak: Math.round(peak / 1048576) },
  }
  console.warn(JSON.stringify(out, null, 2))
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 })
}
