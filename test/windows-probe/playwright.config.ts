import { defineConfig } from '@playwright/test'

// The electron-playwright probe (assess-windows-platform task 7.1). electron.mjs runs it on the
// Windows runner; `npm run test:e2e` does not, since its config reads only test/e2e.
export default defineConfig({
  testDir: '.',
  testMatch: 'launch.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  forbidOnly: true,
})
