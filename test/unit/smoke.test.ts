import { describe, expect, it } from 'vitest'
import { formatSmokeReport, runSmokeTest, SMOKE_REPORT_PREFIX, type SmokeDeps, type SmokeFs, type SmokeUi } from '../../src/main/app/smoke'
import { contract } from '../../src/shared/api'

const goodUi: SmokeUi = {
  url: 'app://veydr/index.html',
  bridge: Object.keys(contract),
  rendered: true,
  sandbox: true,
  contextIsolation: true,
  devToolsOpened: false,
}

function memoryFs(failWrite = false): SmokeFs & { files: Set<string>; dirs: string[] } {
  const files = new Set<string>()
  const dirs: string[] = []
  return {
    files,
    dirs,
    mkdir: (path) => {
      dirs.push(path)
      return Promise.resolve()
    },
    writeNew: (path) => {
      if (failWrite) return Promise.reject(new Error(`EACCES: permission denied, open '${path}'`))
      files.add(path)
      return Promise.resolve()
    },
    remove: (path) => {
      files.delete(path)
      return Promise.resolve()
    },
  }
}

function deps(overrides: Partial<SmokeDeps> = {}): SmokeDeps {
  return {
    packaged: true,
    appPath: '/opt/Veydr/resources/app.asar',
    configDir: () => '/home/dev/.config/Veydr',
    implementation: { name: 'linux', supported: true, portInspector: { list: () => Promise.resolve({ takenAt: 0, ports: [] }) } },
    noSandbox: false,
    loadUi: () => Promise.resolve(goodUi),
    fs: memoryFs(),
    ...overrides,
  }
}

const names = (report: { checks: readonly { name: string }[] }): string[] => report.checks.map((c) => c.name)

describe('runSmokeTest', () => {
  it('passes when every check passes and leaves no probe file behind', async () => {
    const fs = memoryFs()
    const report = await runSmokeTest(deps({ fs }))
    expect(report.result).toBe('pass')
    expect(names(report)).toEqual(['process-sandbox', 'config-dir-writable', 'platform', 'ui-loaded', 'preload-bridge', 'renderer-isolation', 'devtools-disabled'])
    expect(fs.dirs).toEqual(['/home/dev/.config/Veydr'])
    expect(fs.files.size).toBe(0)
  })

  it('does not check DevTools for an unpackaged build', async () => {
    const report = await runSmokeTest(deps({ packaged: false, loadUi: () => Promise.resolve({ ...goodUi, devToolsOpened: null }) }))
    expect(report.result).toBe('pass')
    expect(names(report)).not.toContain('devtools-disabled')
  })

  it('reports only the sandbox failure with --no-sandbox, without touching anything', async () => {
    const fs = memoryFs()
    let loaded = false
    const report = await runSmokeTest(
      deps({
        fs,
        noSandbox: true,
        loadUi: () => {
          loaded = true
          return Promise.resolve(goodUi)
        },
      }),
    )
    expect(report).toMatchObject({ result: 'fail', checks: [{ name: 'process-sandbox', ok: false }] })
    expect(report.checks).toHaveLength(1)
    expect(fs.dirs).toEqual([])
    expect(loaded).toBe(false)
  })

  it('stops after an unwritable configuration directory', async () => {
    const report = await runSmokeTest(deps({ fs: memoryFs(true) }))
    expect(report.result).toBe('fail')
    expect(names(report)).toEqual(['process-sandbox', 'config-dir-writable'])
    expect(report.checks[1]?.detail).toContain('EACCES')
    const thrown = await runSmokeTest(
      deps({
        configDir: () => {
          throw new Error("Failed to get 'userData' path")
        },
      }),
    )
    expect(thrown.checks[1]).toEqual({ name: 'config-dir-writable', ok: false, detail: "Failed to get 'userData' path" })
  })

  it('fails without a platform implementation or when /proc cannot be read', async () => {
    const unsupported = await runSmokeTest(deps({ implementation: { name: 'unsupported', supported: false, portInspector: { list: () => Promise.reject(new Error('unused')) } } }))
    expect(unsupported.checks.find((c) => c.name === 'platform')).toEqual({ name: 'platform', ok: false, detail: 'no platform implementation for unsupported' })
    const unreadable = await runSmokeTest(deps({ implementation: { name: 'linux', supported: true, portInspector: { list: () => Promise.reject(new Error('/proc/net/tcp: EACCES')) } } }))
    expect(unreadable.result).toBe('fail')
    expect(unreadable.checks.find((c) => c.name === 'platform')?.detail).toBe('/proc/net/tcp: EACCES')
  })

  it('fails when the interface does not load, does not render, or is not isolated', async () => {
    const failed = await runSmokeTest(deps({ loadUi: () => Promise.reject(new Error('app://veydr/index.html failed to load: ERR_FILE_NOT_FOUND (-6)')) }))
    expect(failed.result).toBe('fail')
    expect(names(failed)).toEqual(['process-sandbox', 'config-dir-writable', 'platform', 'ui-loaded'])

    const blank = await runSmokeTest(deps({ loadUi: () => Promise.resolve({ ...goodUi, rendered: false }) }))
    expect(blank.checks.find((c) => c.name === 'ui-loaded')?.ok).toBe(false)

    const bridge = await runSmokeTest(deps({ loadUi: () => Promise.resolve({ ...goodUi, bridge: ['app', 'ipcRenderer'] }) }))
    expect(bridge.checks.find((c) => c.name === 'preload-bridge')?.detail).toMatch(/missing \[projects, .*\], unexpected \[ipcRenderer\]/)

    const isolation = await runSmokeTest(deps({ loadUi: () => Promise.resolve({ ...goodUi, sandbox: false }) }))
    expect(isolation.checks.find((c) => c.name === 'renderer-isolation')?.ok).toBe(false)
  })

  it('fails a packaged build whose DevTools open', async () => {
    const report = await runSmokeTest(deps({ loadUi: () => Promise.resolve({ ...goodUi, devToolsOpened: true }) }))
    expect(report.checks.find((c) => c.name === 'devtools-disabled')).toEqual({ name: 'devtools-disabled', ok: false, detail: 'DevTools opened in a packaged build' })
  })

  it('fails when the checks do not finish in time', async () => {
    const report = await runSmokeTest(deps({ timeoutMs: 20, loadUi: () => new Promise<SmokeUi>(() => undefined) }))
    expect(report.result).toBe('fail')
    expect(report.checks.at(-1)).toEqual({ name: 'timeout', ok: false, detail: 'not finished within 20 ms' })
  })

  it('writes the report as one prefixed JSON line', async () => {
    const line = formatSmokeReport(await runSmokeTest(deps()))
    expect(line.startsWith(SMOKE_REPORT_PREFIX)).toBe(true)
    expect(line).not.toContain('\n')
    expect(JSON.parse(line.slice(SMOKE_REPORT_PREFIX.length))).toMatchObject({ result: 'pass', packaged: true })
  })
})
