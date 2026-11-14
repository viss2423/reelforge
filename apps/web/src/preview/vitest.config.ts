/**
 * Vitest config for the preview engine. Pure logic runs in Node (no DOM needed); FFmpeg
 * fixture tests are gated on ffmpeg being on PATH. Run from apps/web:
 *   pnpm exec vitest run --config src/preview/vitest.config.ts
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  test: {
    name: 'preview',
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['dev/**', '**/node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
