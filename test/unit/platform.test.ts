import { describe, expect, it } from 'vitest'
import { NotImplementedError, selectPlatform, UnsupportedPlatformError, type Platform } from '../../src/main/platform'
import type { CommandSpec, SpawnPlan } from '../../src/main/platform/types'
import { createWindowsPlatform } from '../../src/main/platform/windows'

const plan: SpawnPlan = { file: 'node', args: [], cwd: '/tmp', env: {} }
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
})

describe('Windows platform', () => {
  const operations = everyOperation(createWindowsPlatform())

  it('covers every operation of the platform interface', () => {
    expect(Object.keys(operations)).toHaveLength(7)
  })

  for (const [name, run] of Object.entries(operations)) {
    it(`${name} rejects with UnsupportedPlatformError`, async () => {
      const error: unknown = await run().then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(UnsupportedPlatformError)
      expect(error).toMatchObject({ code: 'unsupported_platform', platform: 'win32', operation: name })
    })
  }

  it('fails synchronous operations synchronously (no partial behaviour)', () => {
    const windows = createWindowsPlatform()
    expect(() => windows.commandResolver.resolve(spec, {})).toThrow(UnsupportedPlatformError)
  })
})

describe('other unsupported operating systems', () => {
  for (const [name, run] of Object.entries(everyOperation(selectPlatform('darwin')))) {
    it(`${name} rejects with UnsupportedPlatformError`, async () => {
      await expect(run()).rejects.toMatchObject({ name: 'UnsupportedPlatformError', platform: 'darwin' })
    })
  }
})

// processTree.spawn is implemented (L3) and covered by test/integration/linux-process-tree.test.ts.
const linuxImplemented = new Set(['processTree.spawn'])

describe('Linux placeholders', () => {
  for (const [name, run] of Object.entries(everyOperation(selectPlatform('linux')))) {
    if (linuxImplemented.has(name)) continue
    it(`${name} reports that it is not implemented yet`, async () => {
      await expect(run()).rejects.toBeInstanceOf(NotImplementedError)
    })
  }
})
