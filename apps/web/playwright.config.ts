/**
 * End-to-end tests against the real stack: the production web build served by the real
 * server (`node ../server/src/index.ts`) with an isolated temp data dir and test ports.
 *
 * What the server must support for this run (all test-only, ignored unless set):
 * - `REELFORGE_DATA`            data dir (fresh per run; the server creates it)
 * - `REELFORGE_HTTPS_PORT`      HTTPS port (self-signed / local-CA certificate is fine)
 * - `REELFORGE_HTTP_PORT`       HTTP landing/redirect port
 * - `REELFORGE_WEB_DIST`        web build directory to serve at `/` (SPA fallback)
 * - `REELFORGE_TEST_PAIR_CODE`  fixed, reusable code accepted by `POST /api/pair`
 * - `REELFORGE_PACKS_SYNC=off`  don't pull packs from GitHub (serve the repo's ./packs)
 *
 * Set `RF_E2E_TOOLS_DATA` to a data dir populated by `pnpm bootstrap` to run the real-AI
 * specs (whisper.cpp captions); its toolchain is hard-linked into the run's data dir.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
import { BASE_URL, E2E_DATA, E2E_PAIR_CODE, HTTPS_PORT, HTTP_PORT } from './e2e/env.ts'
import { linkTools } from './e2e/tools.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
// Before the web server boots: it detects whisper.cpp and the models once, at startup.
linkTools()

export default defineConfig({
  testDir: './e2e',
  // The real phone has its own config (playwright.android.config.ts).
  testIgnore: ['android/**'],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // One host does all rendering; parallel exports would only measure contention.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    acceptDownloads: true,
    // Long tests (the full flow) would otherwise spend their whole budget on one stuck click.
    actionTimeout: 30_000,
  },
  projects: [
    { name: 'Pixel 9', use: { ...devices['Pixel 9'] } },
    { name: 'iPhone 16', use: { ...devices['iPhone 16'] } },
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'pnpm run build && node ../server/src/index.ts',
    cwd: here,
    url: `${BASE_URL}/api/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      REELFORGE_DATA: E2E_DATA,
      REELFORGE_HTTPS_PORT: String(HTTPS_PORT),
      REELFORGE_HTTP_PORT: String(HTTP_PORT),
      REELFORGE_WEB_DIST: path.join(here, 'dist'),
      REELFORGE_TEST_PAIR_CODE: E2E_PAIR_CODE,
      REELFORGE_PACKS_SYNC: 'off',
    },
  },
})
