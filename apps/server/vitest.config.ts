import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Tests that drive real models or FFmpeg (each wants every core) and timing benchmarks.
 * They run after the rest, one file at a time: in parallel they starve each other and the
 * timings mean nothing.
 */
const HEAVY = ['test/**/*.integration.test.ts', 'test/**/*.e2e.test.ts', 'test/**/*.perf.test.ts']

export default defineConfig({
  test: {
    // FFmpeg integration tests encode real (tiny) media; leave room on slow CI machines.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...HEAVY],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'heavy',
          include: HEAVY,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
