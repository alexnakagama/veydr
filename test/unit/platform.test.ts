import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { SpawnError } from '../../src/main/platform/errors'
import { selectPlatform, UnsupportedPlatformError, windowsHelperPath, type Platform } from '../../src/main/platform'
import { duplicateEnvName, envNameKey } from '../../src/shared/config'
import type { CommandSpec, LedgerEntry, SpawnPlan } from '../../src/main/platform/types'
import { createWindowsPlatform } from '../../src/main/platform/windows'
import { batchCommandLine } from '../../src/main/platform/windows/command-line'
import type * as HelperTool from '../../src/main/platform/windows/helper-tool'
import type { HelperCheck, HelperPortsReaderOptions } from '../../src/main/platform/windows/helper-tool'
import type * as ProcessTree from '../../src/main/platform/windows/process-tree'
import type { WindowsProcessTreeOptions } from '../../src/main/platform/windows/process-tree'
import { windowsFs } from './support/windows-fs'

// What the Windows composition hands the helper's runners (task 5.1): the real functions run, and
// are only recorded, unless a test sets `fakePorts`, which stands in for the helper's `ports` output.
const wiring = vi.hoisted(() => ({
  checks: [] as HelperCheck[],
  readers: [] as HelperPortsReaderOptions[],
  trees: [] as WindowsProcessTreeOptions[],
  fakePorts: null as string | null,
}))
vi.mock('../../src/main/platform/windows/helper-tool', async (importOriginal) => {
  const actual = await importOriginal<typeof HelperTool>()
  return {
    ...actual,
    createHelperCheck: (...args: Parameters<typeof actual.createHelperCheck>) => {
      const check = actual.createHelperCheck(...args)
      wiring.checks.push(check)
      return check
    },
    createHelperPortsReader: (options: HelperPortsReaderOptions) => {
      wiring.readers.push(options)
      const read = actual.createHelperPortsReader(options)
      return () => (wiring.fakePorts === null ? read() : Promise.resolve(wiring.fakePorts))
    },
  }
})
vi.mock('../../src/main/platform/windows/process-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessTree>()
  return {
    ...actual,
    createWindowsProcessTree: (options: WindowsProcessTreeOptions) => {
      wiring.trees.push(options)
      return actual.createWindowsProcessTree(options)
    },
  }
})

// A full path on every system, so that only the helper's absence is what these tests meet.
const plan: SpawnPlan = { file: process.execPath, args: [], cwd: '/tmp', env: {} }
const spec: CommandSpec = {
  mode: 'direct',
  file: 'node',
  args: [],
  script: '',
  shellPath: null,
  projectRoot: '/tmp',
  cwd: '.',
}

/** Calls every platform operation; sync throws are turned into rejections. */
function everyOperation(platform: Platform): Record<string, () => Promise<unknown>> {
  const call = (fn: () => unknown) => () => new Promise<unknown>((resolve) => resolve(fn()))
  return {
    'processTree.spawn': call(() => platform.processTree.spawn(plan)),
    'processTree.launchDetached': call(() => platform.processTree.launchDetached(plan)),
    'processTree.findSurvivors': call(() => platform.processTree.findSurvivors([])),
    'processTree.terminateSurvivors': call(() => platform.processTree.terminateSurvivors([])),
    'commandResolver.resolve': call(() => platform.commandResolver.resolve(spec, {})),
    'envProvider.base': call(() => platform.envProvider.base()),
    'portInspector.list': call(() => platform.portInspector.list()),
  }
}

describe('platform selection', () => {
  it('selects by OS name', () => {
    expect(selectPlatform('linux')).toMatchObject({ name: 'linux', supported: true })
    expect(selectPlatform('win32')).toMatchObject({ name: 'windows', supported: true })
    expect(selectPlatform('darwin')).toMatchObject({ name: 'unsupported', supported: false })
    expect(selectPlatform('freebsd')).toMatchObject({ name: 'unsupported', supported: false })
  })

  it('gives each selected platform its conventions', () => {
    expect(selectPlatform('linux').conventions).toEqual({ envNames: 'exact', defaultShell: '/bin/sh', directorySync: true })
    expect(selectPlatform('win32', { inherited: { SystemRoot: 'C:\\Windows' } }).conventions).toEqual({
      envNames: 'case-insensitive',
      defaultShell: 'C:\\Windows\\System32\\cmd.exe',
      directorySync: false,
    })
    expect(selectPlatform('darwin').conventions).toEqual({ envNames: 'exact', defaultShell: null, directorySync: true })
    expect(selectPlatform('freebsd').conventions).toEqual({ envNames: 'exact', defaultShell: null, directorySync: true })
  })
})

describe('environment variable name keys', () => {
  it('keeps names unchanged under the exact rule', () => {
    expect(envNameKey('Path', 'exact')).toBe('Path')
    expect(envNameKey('Path', 'exact')).not.toBe(envNameKey('PATH', 'exact'))
  })

  it('gives names differing only in case the same key under the case-insensitive rule', () => {
    expect(envNameKey('Path', 'case-insensitive')).toBe(envNameKey('PATH', 'case-insensitive'))
    expect(envNameKey('node_env', 'case-insensitive')).toBe(envNameKey('NODE_ENV', 'case-insensitive'))
    expect(envNameKey('PATH', 'case-insensitive')).not.toBe(envNameKey('PATHEXT', 'case-insensitive'))
  })

  it('finds the first name that repeats an earlier one under the rule', () => {
    expect(duplicateEnvName([], 'case-insensitive')).toBeNull()
    expect(duplicateEnvName(['PATH', 'Path', 'path'], 'exact')).toBeNull()
    expect(duplicateEnvName(['PORT', 'PORT'], 'exact')).toBe('PORT')
    expect(duplicateEnvName(['NODE_ENV', 'PORT', 'node_env', 'Port'], 'case-insensitive')).toBe('node_env')
  })
})

describe('Windows platform', () => {
  // Each test sees only the wiring of the platforms it creates itself.
  beforeEach(() => {
    for (const list of [wiring.checks, wiring.readers, wiring.trees]) list.length = 0
    wiring.fakePorts = null
  })
  // An absolute path on every system, under a directory that does not exist, so no helper is found.
  const missingHelper = join(tmpdir(), `veydr-no-helper-${process.pid}`, 'veydr-helper.exe')
  const windows = createWindowsPlatform({
    helperPath: missingHelper,
    inherited: { Path: 'C:\\Windows\\System32', SystemRoot: 'D:\\Win', ELECTRON_RUN_AS_NODE: '1', '=C:': 'C:\\' },
  })
  const operations = everyOperation(windows)
  const windowsEntry: LedgerEntry = {
    commandId: 'c1',
    runId: 'r1',
    leader: { pid: 4321, token: '133000000000000000' },
    sessionId: null,
    descendants: [],
  }

  it('covers every operation of the platform interface', () => {
    expect(Object.keys(operations)).toHaveLength(7)
  })

  it('is supported, as a preview, with the Windows conventions and cmd.exe as the default shell', () => {
    expect(windows).toMatchObject({ name: 'windows', supported: true })
    expect(windows.conventions).toEqual({ envNames: 'case-insensitive', defaultShell: 'D:\\Win\\System32\\cmd.exe', directorySync: false })
  })

  it('reads SystemRoot once, regardless of letter case, and falls back to C:\\Windows', () => {
    const inherited: Record<string, string | undefined> = { SYSTEMROOT: 'E:\\WinNT' }
    const platform = createWindowsPlatform({ helperPath: missingHelper, inherited })
    inherited['SYSTEMROOT'] = 'F:\\Elsewhere'
    expect(platform.conventions.defaultShell).toBe('E:\\WinNT\\System32\\cmd.exe')
    // Unset, relative, or holding characters cmd.exe would read: the Windows directory's usual place.
    for (const systemRoot of [undefined, 'Windows', '\\Windows', 'C:\\Win%dows%']) {
      const records: [string, string, Record<string, unknown> | undefined][] = []
      const log = { record: (level: 'info' | 'warn' | 'error', event: string, detail?: Record<string, unknown>) => void records.push([level, event, detail]) }
      const fallback = createWindowsPlatform({ helperPath: missingHelper, inherited: { SystemRoot: systemRoot }, log })
      expect(fallback.conventions.defaultShell).toBe('C:\\Windows\\System32\\cmd.exe')
      // Logged once, without the rejected value.
      expect(records).toEqual([['warn', 'platform.windows-system-root-fallback', { set: systemRoot !== undefined, cmdExe: 'C:\\Windows\\System32\\cmd.exe' }]])
    }
    const records: string[] = []
    createWindowsPlatform({ helperPath: missingHelper, inherited: { SystemRoot: 'C:\\Windows' }, log: { record: (_level, event) => void records.push(event) } })
    expect(records).toEqual([])
  })

  it('selectPlatform passes the inherited environment and the log on to the Windows platform', async () => {
    const records: [string, string, Record<string, unknown> | undefined][] = []
    const log = { record: (level: 'info' | 'warn' | 'error', event: string, detail?: Record<string, unknown>) => void records.push([level, event, detail]) }
    const selected = selectPlatform('win32', { log, helperPath: missingHelper, inherited: { Path: 'C:\\a', PATH: 'C:\\b', SystemRoot: 'D:\\Win' } })
    expect(selected.conventions.defaultShell).toBe('D:\\Win\\System32\\cmd.exe')
    await expect(selected.envProvider.base()).resolves.toEqual({ env: { Path: 'C:\\a', SystemRoot: 'D:\\Win' }, warnings: [] })
    expect(records).toEqual([['info', 'environment.names-merged', { kept: 'Path', merged: ['PATH'] }]])
  })

  it("starts commands from Veydr's inherited environment, without runtime variables, each name once", async () => {
    const { env, warnings } = await windows.envProvider.base()
    expect(warnings).toEqual([])
    expect(env).toEqual({ Path: 'C:\\Windows\\System32', SystemRoot: 'D:\\Win' })
  })

  it('resolves commands with the Windows rules, and batch files through cmd.exe in the system directory', async () => {
    const platform = createWindowsPlatform({
      helperPath: missingHelper,
      inherited: { SystemRoot: 'D:\\Win' },
      resolverFs: windowsFs(['C:\\project\\README.md', 'C:\\nodejs\\npm.cmd', 'D:\\Win\\System32\\cmd.exe']),
    })
    const windowsSpec: CommandSpec = { ...spec, file: 'npm', args: ['run', 'dev'], projectRoot: 'C:\\project' }
    await expect(platform.commandResolver.resolve(windowsSpec, { Path: 'C:\\nodejs' })).resolves.toEqual({
      ok: true,
      plan: {
        file: 'D:\\Win\\System32\\cmd.exe',
        args: [],
        cwd: 'C:\\project',
        env: { Path: 'C:\\nodejs' },
        // The candidate's spelling: the default `PATHEXT` extensions are upper case.
        commandLine: batchCommandLine('D:\\Win\\System32\\cmd.exe', 'C:\\nodejs\\npm.CMD', ['run', 'dev']),
      },
    })
    // Shell mode accepts cmd.exe only.
    const shellSpec: CommandSpec = { ...windowsSpec, mode: 'shell', file: '', args: [], script: 'echo hi', shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }
    await expect(platform.commandResolver.resolve(shellSpec, {})).resolves.toMatchObject({ ok: false, diagnostics: [expect.stringContaining('cmd.exe only')] })
  })

  it('launchDetached refuses a batch file without cmd.exe before starting anything', async () => {
    await expect(windows.processTree.launchDetached({ file: 'C:\\tools\\code.cmd', args: ['C:\\project'], cwd: 'C:\\project', env: {} })).rejects.toBeInstanceOf(SpawnError)
  })

  it("lists ports through the helper's ports reader, given the helper check the process tree uses", async () => {
    const platform = createWindowsPlatform({ helperPath: missingHelper, inherited: { SystemRoot: 'C:\\Windows' } })
    // One check of the platform's helper, shared by the process tree and the ports reader.
    expect(wiring.checks).toHaveLength(1)
    expect(wiring.checks[0]?.helperPath).toBe(missingHelper)
    expect(wiring.trees).toHaveLength(1)
    expect(wiring.trees[0]?.helperCheck).toBe(wiring.checks[0])
    expect(wiring.readers).toHaveLength(1)
    expect(wiring.readers[0]).toEqual({ helperPath: missingHelper, check: wiring.checks[0] })

    // A fake `ports` line: the platform's inspector lists it, as the helper's output would be.
    const created = '133485407400000000'
    wiring.fakePorts = `${JSON.stringify({
      type: 'ports',
      takenAt: '133485408000000000',
      listeners: [{ family: 'ipv4', address: '7f000001', port: 5173, pid: 4248 }],
      owners: [{ pid: 4248, state: 'known', created, image: 'C:\\Program Files\\nodejs\\node.exe' }],
    })}\n`
    try {
      await expect(platform.portInspector.list()).resolves.toEqual({
        takenAt: Date.UTC(2024, 0, 1),
        ports: [{ family: 'ipv4', address: '127.0.0.1', port: 5173, owner: { kind: 'known', processes: [{ identity: { pid: 4248, token: created }, name: 'node.exe' }] } }],
      })
    } finally {
      wiring.fakePorts = null
    }
  })

  it('portInspector.list is implemented: without the helper it rejects with a plain Error naming it', async () => {
    const error: unknown = await operations['portInspector.list']?.().then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(UnsupportedPlatformError)
    expect(error).not.toBeInstanceOf(SpawnError)
    expect(error).toMatchObject({ message: `The Windows helper could not list the listening ports: Windows helper not found: ${missingHelper}` })
  })

  it('spawns through the helper, and refuses to start without it', async () => {
    const error: unknown = await windows.processTree.spawn(plan).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SpawnError)
    expect(error).toMatchObject({ message: `Windows helper not found: ${missingHelper}` })
  })

  it('finds and terminates survivors through the helper', async () => {
    // Nothing recorded: the helper is not needed.
    await expect(windows.processTree.findSurvivors([])).resolves.toEqual([])
    await expect(windows.processTree.terminateSurvivors([])).resolves.toEqual({ graceful: 'yes', forced: false, survivors: [] })
    // A recorded Windows process needs the helper, which is missing.
    await expect(windows.processTree.findSurvivors([windowsEntry])).rejects.toMatchObject({
      name: 'SpawnError',
      message: `Windows helper not found: ${missingHelper}`,
    })
  })

  it('selectPlatform passes the helper path, and without one every helper operation rejects', async () => {
    await expect(selectPlatform('win32', { helperPath: missingHelper }).processTree.spawn(plan)).rejects.toMatchObject({
      message: `Windows helper not found: ${missingHelper}`,
    })
    const unconfigured = selectPlatform('win32')
    await expect(unconfigured.processTree.spawn(plan)).rejects.toMatchObject({
      name: 'SpawnError',
      message: 'The Windows helper path is not configured',
    })
    await expect(unconfigured.processTree.findSurvivors([windowsEntry])).rejects.toMatchObject({
      message: 'The Windows helper path is not configured',
    })
  })

  it('selectPlatform logs a Windows selection without a helper path once, at selection', () => {
    const records: [string, string][] = []
    const log = { record: (level: 'info' | 'warn' | 'error', event: string) => void records.push([level, event]) }
    selectPlatform('win32', { log, inherited: { SystemRoot: 'C:\\Windows' } })
    expect(records).toEqual([['error', 'platform.windows-helper-unconfigured']])
    records.length = 0
    selectPlatform('win32', { log, helperPath: missingHelper, inherited: { SystemRoot: 'C:\\Windows' } })
    selectPlatform('linux', { log })
    expect(records).toEqual([])
  })

  it('a relative helper path is refused, so the helper is never looked up on PATH', async () => {
    await expect(createWindowsPlatform({ helperPath: 'veydr-helper.exe' }).processTree.spawn(plan)).rejects.toMatchObject({
      name: 'SpawnError',
      message: 'The Windows helper path must be absolute: veydr-helper.exe',
    })
  })

  it('unpackaged, the composition root finds the helper where the build script puts it', () => {
    const location = { packaged: false, appPath: join('app', 'root'), resourcesPath: join('electron', 'resources') }
    expect(windowsHelperPath(location)).toBe(join('app', 'root', 'out-helper', 'veydr-helper.exe'))
  })

  it('packaged, the composition root finds the helper beside app.asar, where the package places it', () => {
    const resourcesPath = join('C:', 'Users', 'u', 'AppData', 'Local', 'Programs', 'veydr', 'resources')
    const location = { packaged: true, appPath: join(resourcesPath, 'app.asar'), resourcesPath }
    expect(windowsHelperPath(location)).toBe(join(resourcesPath, 'veydr-helper.exe'))
  })

  it('packaged, the helper path is never below a directory ending in app.asar, from which nothing can be started', () => {
    // Every ancestor of the path is checked, case-insensitively as on Windows, splitting on both
    // separators: the helper path is joined with the host's separator, so on Linux the
    // backslash-separated inputs below still give a Windows-shaped path, covered on every system.
    // The application path itself always ends in app.asar when packaged.
    const belowAnArchive = (path: string): boolean =>
      path.split(/[\\/]/).slice(0, -1).some((segment) => segment.toLowerCase().endsWith('app.asar'))
    const windowsResources = 'C:\\Users\\u\\AppData\\Local\\Programs\\veydr\\resources'
    for (const resourcesPath of [windowsResources, join('C:', 'Program Files', 'veydr', 'resources'), join('opt', 'veydr', 'resources'), join('resources')]) {
      const appPath = `${resourcesPath}${resourcesPath === windowsResources ? '\\' : sep}APP.ASAR`
      expect(belowAnArchive(windowsHelperPath({ packaged: false, appPath, resourcesPath }))).toBe(true)
      const packaged = windowsHelperPath({ packaged: true, appPath, resourcesPath })
      expect(belowAnArchive(packaged)).toBe(false)
      expect(packaged.endsWith('veydr-helper.exe')).toBe(true)
    }
  })

  it('packaged without a resources path, the helper path is relative, which the platform refuses to start', async () => {
    const path = windowsHelperPath({ packaged: true, appPath: '', resourcesPath: '' })
    expect(path).toBe('veydr-helper.exe')
    expect(isAbsolute(path)).toBe(false)
    await expect(createWindowsPlatform({ helperPath: path }).processTree.spawn(plan)).rejects.toMatchObject({
      name: 'SpawnError',
      message: 'The Windows helper path must be absolute: veydr-helper.exe',
    })
  })
})

describe('other unsupported operating systems', () => {
  for (const [name, run] of Object.entries(everyOperation(selectPlatform('darwin')))) {
    it(`${name} rejects with UnsupportedPlatformError`, async () => {
      await expect(run()).rejects.toMatchObject({ name: 'UnsupportedPlatformError', platform: 'darwin' })
    })
  }
})

// Every Linux operation is implemented, each covered where it lives: processTree.spawn (L3) by
// test/integration/linux-process-tree.test.ts; the survivor operations (L4) by
// test/unit/linux-survivors.test.ts and test/integration/crash-recovery.test.ts; launchDetached,
// the resolver, and the environment (L5) by test/integration/linux-commands.test.ts; the port
// inspector (L7) by test/unit/linux-ports.test.ts and test/integration/linux-ports.test.ts.
