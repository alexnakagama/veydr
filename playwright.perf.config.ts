import { defineConfig } from '@playwright/test'

// Performance scenarios P1–P4 (design D14): `test/perf/logs.perf.ts`.
export default defineConfig({
  testDir: 'test/perf',
  testMatch: '**/*.perf.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  reporter: [['list']],
  forbidOnly: true,
})
