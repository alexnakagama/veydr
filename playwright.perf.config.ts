import { defineConfig } from '@playwright/test'

// Performance scenarios P1–P4 (design D14) land in task group L6.
export default defineConfig({
  testDir: 'test/perf',
  testMatch: '**/*.perf.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  reporter: [['list']],
  forbidOnly: true,
})
