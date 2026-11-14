/**
 * Real Android device over USB (`e2e/android`): the same real server, data dir and fixtures
 * as playwright.config.ts; the spec attaches to the phone's Chrome itself (adb + CDP), so the
 * project needs no browser of its own. Skips, saying why, when no device is attached.
 *
 *   ADB=<path to adb> pnpm --filter @reelforge/web test:e2e:android
 */
import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

export default defineConfig({
  ...base,
  testDir: './e2e/android',
  testIgnore: [],
  retries: 0,
  timeout: 240_000,
  projects: [{ name: 'Android device' }],
})
