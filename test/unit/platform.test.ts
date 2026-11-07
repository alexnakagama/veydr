import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpawnError } from '../../src/main/platform/errors'
import { selectPlatform, UnsupportedPlatformError, windowsHelperPath, type Platform } from '../../src/main/platform'
import { duplicateEnvName, envNameKey } from '../../src/shared/config'
import type { CommandSpec, LedgerEntry, SpawnPlan } from '../../src/main/platform/types'
import { createWindowsPlatform } from '../../src/main/platform/windows'

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
    expect(selectPlatform('win32')).toMatchObject({ name: 'windows', supported: false })
    expect(selectPlatform('darwin')).toMatchObject({ name: 'unsupported', supported: false })
    expect(selectPlatform('freebsd')).toMatchObject({ name: 'unsupported', supported: false })
  })

  it('gives each selected platform its conventions', () => {
    expect(selectPlatform('linux').conventions).toEqual({ envNames: 'exact', defaultShell: '/bin/sh', directorySync: true })
    expect(selectPlatform('win32').conventions).toEqual({ envNames: 'case-insensitive', defaultShell: null, directorySync: false })
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
  // An absolute path on every system, under a directory that does not exist, so no helper is found.
  const missingHelper = join(tmpdir(), `veydr-no-helper-${process.pid}`, 'veydr-helper.exe')
  const windows = createWindowsPlatform({ helperPath: missingHelper })
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

  it('is not supported yet and keeps the Windows conventions', () => {
    expect(windows).toMatchObject({ name: 'windows', supported: false })
    expect(windows.conventions).toEqual({ envNames: 'case-insensitive', defaultShell: null, directorySync: false })
  })

  // Not implemented until W2 (resolver, environment, launchDetached) and W3 (ports), design D6.
  for (const name of ['processTree.launchDetached', 'commandResolver.resolve', 'envProvider.base', 'portInspector.list']) {
    it(`${name} rejects with UnsupportedPlatformError`, async () => {
      const error: unknown = await operations[name]?.().then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(UnsupportedPlatformError)
      expect(error).toMatchObject({ code: 'unsupported_platform', platform: 'win32', operation: name })
    })
  }

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
    selectPlatform('win32', { log })
    expect(records).toEqual([['error', 'platform.windows-helper-unconfigured']])
    records.length = 0
    selectPlatform('win32', { log, helperPath: missingHelper })
    selectPlatform('linux', { log })
    expect(records).toEqual([])
  })

  it('a relative helper path is refused, so the helper is never looked up on PATH', async () => {
    await expect(createWindowsPlatform({ helperPath: 'veydr-helper.exe' }).processTree.spawn(plan)).rejects.toMatchObject({
      name: 'SpawnError',
      message: 'The Windows helper path must be absolute: veydr-helper.exe',
    })
  })

  it('the composition root finds the helper where the build script puts it', () => {
    expect(windowsHelperPath(join('app', 'root'))).toBe(join('app', 'root', 'out-helper', 'veydr-helper.exe'))
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
