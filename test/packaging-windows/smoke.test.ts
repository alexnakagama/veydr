import { beforeAll, describe, expect, it } from 'vitest'
import { ALL_SMOKE_CHECKS, cleanEnv, requirePackages, run, smokeReportOf, unpackedBinary } from './support'

// `--smoke-test` of the unpacked Windows build (add-windows-packaging design D3, task 2.5): the UI is
// loaded from app.asar, and the platform check lists ports through resources\veydr-helper.exe, so
// it fails if the packaged app cannot find or start its helper (design D2). On Windows the
// configuration directory cannot be redirected; the smoke test only writes and removes a uniquely
// named probe file in it.

describe.skipIf(process.platform !== 'win32')('[windows-only: the packaged Windows binary] --smoke-test of the unpacked build', () => {
  beforeAll(() => requirePackages())

  it('passes all seven checks, packaged, from resources\\app.asar, with listening sockets read through the packaged helper', async () => {
    const result = await run(unpackedBinary, ['--smoke-test'], cleanEnv())
    const report = smokeReportOf(result)
    // Recorded below group 2 of tasks.md.
    console.log(`smoke report: ${JSON.stringify(report)}`)
    expect(report.checks.filter((c) => !c.ok)).toEqual([])
    expect(report.checks.map((c) => c.name)).toEqual(ALL_SMOKE_CHECKS)
    expect(report).toMatchObject({ result: 'pass', packaged: true, appPath: expect.stringMatching(/\\resources\\app\.asar$/) as unknown })
    expect(report.checks.find((c) => c.name === 'platform')?.detail).toMatch(/^windows: \d+ environment variables(?: \([^)]*\))?, \d+ listening sockets readable$/)
    expect(result.code).toBe(0)
  })
})
