import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // FFmpeg integration tests spawn processes; keep generous headroom on slow CI runners.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/compile/**'],
      reporter: ['text-summary', 'text'],
    },
  },
})
