/**
 * UI-only Playwright run: specs that mock the whole API with `page.route` (timeline, editing)
 * against the production web build served by `vite preview` — no ReelForge server, data dir
 * or media fixtures needed. `pnpm --filter @reelforge/web test:e2e:ui`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.RF_E2E_UI_PORT ?? 4174)

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'timeline.spec.ts',
    'editing.spec.ts',
    'ai-beats.spec.ts',
    'background.spec.ts',
    'music.spec.ts',
    'trending.spec.ts',
    'autoedit.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'Pixel 9 (mocked API)', use: { ...devices['Pixel 9'] } },
    { name: 'iPhone 16 (mocked API)', use: { ...devices['iPhone 16'] } },
    {
      name: 'Desktop Chrome (mocked API)',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm run build && pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: here,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
