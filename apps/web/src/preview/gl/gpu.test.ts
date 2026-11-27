/**
 * Runs the GPU self-check page (dev/gpucheck.ts) in real Chromium via Playwright: the GLSL
 * the preview ships is compared pixel-by-pixel with the CPU references that the other tests
 * verify against FFmpeg. Gated on Playwright's Chromium being installed
 * (`pnpm dlx playwright install chromium`); prints why when skipped.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TransitionType } from '@reelforge/core'
import { chromium, type Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GpuCheckResult } from '../dev/gpucheck.ts'

const executable = ((): string => {
  try {
    return chromium.executablePath()
  } catch {
    return ''
  }
})()
const HAS_CHROMIUM = executable !== '' && existsSync(executable)
if (!HAS_CHROMIUM) {
  console.warn('[preview tests] Playwright Chromium not installed — GPU self-check skipped')
}

/**
 * Allowed fraction of samples off by more than 2 LSB. Everything else must agree (to within
 * 0.2 % edge pixels). Exceptions, both invisible in playback:
 * - pixelize: block edges land exactly on integer pixels and GLSL division is not IEEE-exact
 *   (2.5 ULP), so a whole column/row of blocks may start one pixel earlier than in xfade;
 * - spin: at the half-turn cos/sin of π are not exactly −1/0 on the GPU, which moves samples
 *   lying exactly on a pixel boundary by one pixel.
 */
const LIMITS: Record<string, number> = {
  default: 0.002,
  pixelize: 0.12,
  spin: 0.02,
}

const limitFor = (name: string): number => {
  const type = /^transition:(\w+)@/.exec(name)?.[1]
  return (type === undefined ? undefined : LIMITS[type]) ?? LIMITS.default!
}

describe.skipIf(!HAS_CHROMIUM)('GPU shaders vs CPU references (Chromium)', () => {
  let server: ViteDevServer
  let browser: Browser
  let results: GpuCheckResult[] = []
  const pageErrors: string[] = []

  beforeAll(async () => {
    server = await createServer({
      configFile: fileURLToPath(new URL('../dev/vite.config.ts', import.meta.url)),
      logLevel: 'error',
      server: { hmr: false, watch: null, port: 0 },
    })
    await server.listen()
    browser = await chromium.launch({ args: ['--ignore-gpu-blocklist'] })
    const page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(new URL('gpucheck.html', server.resolvedUrls!.local[0]).href)
    await page.waitForFunction(() => window.__rfGpuCheck !== undefined, null, { timeout: 30_000 })
    results = await page.evaluate(() => window.__rfGpuCheck!)
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  it('runs the check page without errors', () => {
    expect(pageErrors).toEqual([])
  })

  it('covers every path', () => {
    const names = results.map((r) => r.name)
    expect(names).toContain('identity')
    expect(names).toContain('lut3d')
    expect(names).toContain('chromakey')
    for (const m of ['remove', 'color', 'image', 'blur']) expect(names).toContain(`background:${m}`)
    expect(names.filter((n) => n.startsWith('transition:')).length).toBe(
      TransitionType.options.length * 5,
    )
    expect(names.filter((n) => n.startsWith('blend:')).length).toBe(7)
  })

  it('layer pass reproduces the source exactly', () => {
    const r = results.find((x) => x.name === 'identity')!
    expect(r.maxErr).toBeLessThanOrEqual(1)
  })

  it('every shader path matches its CPU reference', () => {
    const failures = results
      .filter((r) => r.badFrac > limitFor(r.name))
      .map((r) => `${r.name}: max ${r.maxErr}, ${(r.badFrac * 100).toFixed(2)}% > 2 LSB`)
    expect(failures).toEqual([])
  })
})
