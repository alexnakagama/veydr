import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appImageEnv, appImagePath, cleanEnv, requirePackages, run, smokeReportOf, unpackedBinary } from './support'

const ALL_CHECKS = ['process-sandbox', 'config-dir-writable', 'platform', 'ui-loaded', 'preload-bridge', 'renderer-isolation', 'devtools-disabled']

let work: string
beforeAll(() => {
  requirePackages()
  work = mkdtempSync(join(tmpdir(), 'veydr-smoke-'))
})
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

describe('--smoke-test of the packages (task 9.2)', () => {
  it('passes for the unpacked build: UI loaded from app.asar, DevTools disabled, nothing configured or started', async () => {
    const configHome = join(work, 'unpacked')
    const result = await run(unpackedBinary, ['--smoke-test'], cleanEnv({ XDG_CONFIG_HOME: configHome }))
    const report = smokeReportOf(result)
    expect(report.checks.filter((c) => !c.ok)).toEqual([])
    expect(report.checks.map((c) => c.name)).toEqual(ALL_CHECKS)
    expect(report).toMatchObject({ result: 'pass', packaged: true, appPath: expect.stringMatching(/\/resources\/app\.asar$/) as unknown })
    expect(result.code).toBe(0)
    // Neither the configuration nor the run ledger was created.
    expect(readdirSync(join(configHome, 'Veydr')).filter((name) => /^config|^runtime$|^\.smoke-test/.test(name))).toEqual([])
  })

  it('passes for the AppImage', async () => {
    const result = await run(appImagePath, ['--smoke-test'], appImageEnv({ XDG_CONFIG_HOME: join(work, 'appimage') }), 120_000)
    const report = smokeReportOf(result)
    expect(report.checks.filter((c) => !c.ok)).toEqual([])
    expect(report.result).toBe('pass')
    expect(result.code).toBe(0)
  })
})
