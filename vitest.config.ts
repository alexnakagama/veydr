import { defineConfig } from 'vitest/config'

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        // Inspects and runs the Linux packages in dist/ (`npm run test:packaging` builds them first).
        test: {
          name: 'packaging',
          include: ['test/packaging/**/*.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        // Measurements recorded as task notes (`npm run measure`); not part of `verify`.
        test: {
          name: 'measure',
          include: ['test/measure/**/*.measure.ts'],
          environment: 'node',
          testTimeout: 600_000,
        },
      },
    ],
  },
})
