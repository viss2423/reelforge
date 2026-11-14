import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // FFmpeg integration tests encode real (tiny) media; leave room on slow CI machines.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
