/**
 * Automated preview measurement in real Chromium (Playwright): starts the harness' Vite
 * server, loads the demo project and reports seek latency, playback smoothness, compose
 * cost, A/V clock drift and snapshot time. Run from apps/web:
 *
 *   node src/preview/dev/measure.ts [--headed] [--decoder=element] [--out=<dir>]
 *
 * `--out` also saves snapshots at a few times (PNG) for visual inspection.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { generateFixtures } from './fixtures.ts'

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const headed = process.argv.includes('--headed')
const decoder = arg('decoder') ?? 'auto'
const outDir = arg('out')

generateFixtures()
const server = await createServer({
  configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
  logLevel: 'warn',
  // a measurement run must not be reloaded by edits made while it runs
  server: { hmr: false, watch: null },
})
await server.listen()
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5199/'
const browser = await chromium.launch({
  headless: !headed,
  args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-gpu'],
})
const errors: string[] = []
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  })
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(`${base}?demo&decoder=${decoder}`)
  await page.waitForFunction(() => (window.__rfHarness?.engine.duration ?? 0) > 0, null, {
    timeout: 30_000,
  })

  const env = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return {
      userAgent: navigator.userAgent,
      renderer: ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown',
      webcodecs: typeof VideoDecoder === 'function',
      duration: window.__rfHarness?.engine.duration ?? 0,
    }
  })

  /** Seek to t and resolve with ms until a composited frame shows exact pixels at t. */
  const seekLatency = (t: number): Promise<number> =>
    page.evaluate(
      (t) =>
        new Promise<number>((resolve, reject) => {
          const e = window.__rfHarness!.engine
          const t0 = performance.now()
          e.seek(t)
          const check = (): void => {
            const s = e.stats!
            if (s.time === e.time && s.frameExact && s.framesComposited > 0)
              resolve(performance.now() - t0)
            else if (performance.now() - t0 > 5000) reject(new Error(`seek ${t} never settled`))
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
      t,
    )

  // warm up: first frame (demux moov, decoder configure, shader compile)
  const firstFrameMs = await seekLatency(0)
  const duration = env.duration
  const seeks: number[] = []
  let x = 0x9e3779b9
  for (let i = 0; i < 40; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    seeks.push(await seekLatency(Math.floor((x / 2 ** 32) * (duration - 100_000))))
  }
  // frame stepping (the common "nudge" interaction): 30 consecutive frames forward
  const steps: number[] = []
  const stepStart = Math.floor(duration / 3)
  for (let i = 0; i < 30; i++) steps.push(await seekLatency(stepStart + Math.round((i * 1e6) / 30)))

  // playback from 0 for the whole timeline
  const play = await page.evaluate(
    (duration) =>
      new Promise<Record<string, number | string>>((resolve) => {
        const e = window.__rfHarness!.engine
        const s = e.stats!
        e.seek(0)
        const base = {
          composited: s.framesComposited,
          inexact: s.inexactFrames,
          decoded: s.framesDecoded,
        }
        const waitsAt: number[] = []
        const off = e.on('waiting', (t) => waitsAt.push(t))
        const intervals: number[] = []
        const drift: number[] = []
        let last = 0
        let t0 = 0
        let e0 = 0
        const tick = (now: number): void => {
          if (last) intervals.push(now - last)
          last = now
          if (!t0 && e.time > 0) {
            t0 = now
            e0 = e.time
          } else if (t0 && e.playing) {
            drift.push((e.time - e0) / 1000 - (now - t0))
          }
          // a stuck playback must end the run (and show up as wallMs ≫ timelineMs)
          const overdue = t0 > 0 && now - t0 > (duration / 1000) * 3
          if ((e.playing || !t0) && !overdue) requestAnimationFrame(tick)
          else {
            e.pause()
            off()
            intervals.sort((a, b) => a - b)
            const pct = (p: number): number => intervals[Math.floor(intervals.length * p)] ?? 0
            const absDrift = drift.map(Math.abs)
            resolve({
              wallMs: now - t0,
              timelineMs: duration / 1000,
              frames: s.framesComposited - base.composited,
              inexactFrames: s.inexactFrames - base.inexact,
              decodedFrames: s.framesDecoded - base.decoded,
              waits: waitsAt.length,
              waitsAtMs: waitsAt.map((t) => t / 1000).join(' '),
              fps: s.fps,
              composeMsEma: s.frameMs,
              rafP50: pct(0.5),
              rafP95: pct(0.95),
              rafP99: pct(0.99),
              maxDriftMs: Math.max(0, ...absDrift),
              finalDriftMs: drift.at(-1) ?? 0,
              renderWidth: s.renderWidth,
              renderHeight: s.renderHeight,
              qualityLevel: s.qualityLevel,
              decoderResets: s.decoderResets,
              gpuMB: s.gpuBytes / 1048576,
            })
          }
        }
        e.play()
        requestAnimationFrame(tick)
      }),
    duration,
  )

  // snapshot cost (+ optional PNGs for visual inspection)
  const snapTimes = [500_000, 2_250_000, 3_000_000, 6_000_000, 9_000_000].filter(
    (t) => t < duration,
  )
  const snaps: { t: number; ms: number; bytes: number }[] = []
  for (const t of snapTimes) {
    await seekLatency(t)
    const r = await page.evaluate(async () => {
      const t0 = performance.now()
      const blob = await window.__rfHarness!.engine.snapshot({ type: 'image/png' })
      const ms = performance.now() - t0
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { ms, data: Array.from(bytes) }
    })
    snaps.push({ t, ms: r.ms, bytes: r.data.length })
    if (outDir) {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(path.join(outDir, `snap-${t}.png`), Uint8Array.from(r.data))
    }
  }

  const stat = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y)
    const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
    return { p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +at(1).toFixed(1) }
  }
  const report = {
    env,
    decoder,
    firstFrameMs: +firstFrameMs.toFixed(1),
    randomSeekMs: stat(seeks),
    frameStepMs: stat(steps),
    playback: Object.fromEntries(
      Object.entries(play).map(([k, v]) => [
        k,
        typeof v === 'string' || Number.isInteger(v) ? v : +v.toFixed(2),
      ]),
    ),
    snapshots: snaps.map((s) => ({ ...s, ms: +s.ms.toFixed(1) })),
    errors,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await browser.close()
  await server.close()
}
