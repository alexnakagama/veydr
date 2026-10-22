import { defineConfig } from '@playwright/test'

// E2E tests drive the built app (`npm run test:e2e` builds first). One worker:
// each test launches a real Electron window.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  forbidOnly: true,
})
