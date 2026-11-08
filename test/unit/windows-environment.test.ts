import { describe, expect, it } from 'vitest'
import type { PlatformLog } from '../../src/main/platform/types'
import { createWindowsEnvProvider, windowsBaseEnvironment } from '../../src/main/platform/windows/environment'
import { effectiveEnvironment, previewEntries } from '../../src/main/projects/environment'

// The Windows environment provider (add-windows-environment-and-commands design D3), unit-tested
// with a fake inherited environment on every system.

interface Recorded {
  readonly level: string
  readonly event: string
  readonly detail: Record<string, unknown> | undefined
}

function recordingLog(): PlatformLog & { readonly entries: Recorded[] } {
  const entries: Recorded[] = []
  return { entries, record: (level, event, detail) => entries.push({ level, event, detail }) }
}

/** What Veydr inherits on Windows, with the entries D3 is about. */
const inherited = (): Record<string, string | undefined> => ({
  Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  '=C:': 'C:\\Users\\dev',
  '=ExitCode': '00000000',
  PATH: 'C:\\Elsewhere',
  ELECTRON_RUN_AS_NODE: '1',
  Electron_No_Attach_Console: '1',
  SystemRoot: 'C:\\Windows',
  UNSET: undefined,
})

describe('Windows environment provider (design D3)', () => {
  it('[spec:project-registry/windows-base-environment] returns the inherited environment without runtime variables, one entry per name regardless of case', async () => {
    const log = recordingLog()
    const result = await createWindowsEnvProvider({ inherited: inherited(), log }).base()
    expect(result).toEqual({
      env: {
        Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        SystemRoot: 'C:\\Windows',
      },
      warnings: [],
    })
    expect(Object.keys(result.env).filter((name) => name.toUpperCase() === 'PATH')).toEqual(['Path'])
    // The names only: no value of either spelling is logged.
    expect(log.entries).toEqual([{ level: 'info', event: 'environment.names-merged', detail: { kept: 'Path', merged: ['PATH'] } }])
    expect(JSON.stringify(log.entries)).not.toContain('Elsewhere')
  })

  it('[spec:project-registry/windows-base-environment] gives a PATH override exactly one entry, with its own name and value', async () => {
    const { env } = await createWindowsEnvProvider({ inherited: inherited() }).base()
    const override = [{ key: 'PATH', value: 'C:\\Tools', secret: false }]
    const effective = effectiveEnvironment(env, override, 'case-insensitive')
    expect(Object.entries(effective).filter(([name]) => name.toUpperCase() === 'PATH')).toEqual([['PATH', 'C:\\Tools']])
    expect(previewEntries(env, { env: override }, 'case-insensitive').filter((entry) => entry.key.toUpperCase() === 'PATH')).toEqual([
      { key: 'PATH', secret: false, value: 'C:\\Tools', source: 'override' },
    ])
  })

  it('keeps the first spelling in enumeration order, which a case-insensitive lookup finds, whatever its case', () => {
    expect(windowsBaseEnvironment({ path: 'first', PATH: 'second', Path: 'third' })).toEqual({ path: 'first' })
    expect(windowsBaseEnvironment({ PATH: 'second', path: 'first' })).toEqual({ PATH: 'second' })
  })

  it('logs one merge per variable, and nothing when no names differ only in case', () => {
    const log = recordingLog()
    windowsBaseEnvironment({ Path: 'a', PATH: 'b', path: 'c', Temp: 'd', TEMP: 'e', Home: 'f' }, log)
    expect(log.entries.map((entry) => entry.detail)).toEqual([
      { kept: 'Path', merged: ['PATH', 'path'] },
      { kept: 'Temp', merged: ['TEMP'] },
    ])
    const quiet = recordingLog()
    windowsBaseEnvironment({ Path: 'a', Temp: 'd' }, quiet)
    expect(quiet.entries).toEqual([])
  })

  it('removes runtime variables in any letter case, before merging', () => {
    expect(
      windowsBaseEnvironment({
        electron_run_as_node: '1',
        Electron_Enable_Logging: '1',
        chrome_desktop: 'x',
        No_At_Bridge: '1',
        AppDir: 'C:\\app',
        appimage: 'C:\\app.AppImage',
        Argv0: 'x',
        owd: 'C:\\',
        KEEP: 'yes',
      }),
    ).toEqual({ KEEP: 'yes' })
  })

  it('never applies the AppImage cleanup to a Windows Path, whatever APPDIR is set to', () => {
    // On Linux an APPDIR makes `withoutRuntimeVariables` split values on ":", which would cut `C:\…`.
    expect(windowsBaseEnvironment({ APPDIR: 'C:\\', appdir: '/', Path: 'C:\\Tools;D:\\Bin', XDG_DATA_DIRS: '/usr/share/' })).toEqual({
      Path: 'C:\\Tools;D:\\Bin',
      XDG_DATA_DIRS: '/usr/share/',
    })
  })

  it('keeps a variable named __proto__ like any other, and returns no inherited properties', () => {
    const inheritedEnv = JSON.parse('{"__proto__": "x", "A": "1"}') as Record<string, string>
    const env = windowsBaseEnvironment(inheritedEnv)
    expect(Object.entries(env)).toEqual([
      ['__proto__', 'x'],
      ['A', '1'],
    ])
    expect('toString' in env).toBe(false)
  })

  it('reports a failure to read the environment as a rejection, not a throw', async () => {
    const throwing = new Proxy({}, { ownKeys: () => { throw new Error('unreadable') } })
    const pending = createWindowsEnvProvider({ inherited: throwing }).base()
    await expect(pending).rejects.toThrow('unreadable')
  })

  it('drops names that are empty, hold "=" or NUL, and values that hold NUL', () => {
    expect(
      windowsBaseEnvironment({
        '': 'empty name',
        '=C:': 'C:\\',
        '=::': '::\\',
        'A=B': 'inner equals',
        'NUL\0NAME': 'x',
        NULVALUE: 'a\0b',
        EMPTY_VALUE: '',
        OK: 'kept',
      }),
    ).toEqual({ EMPTY_VALUE: '', OK: 'kept' })
  })

  it('reads the inherited environment anew on every call, and never warns', async () => {
    const live: Record<string, string | undefined> = { A: '1' }
    const provider = createWindowsEnvProvider({ inherited: live })
    expect(await provider.base()).toEqual({ env: { A: '1' }, warnings: [] })
    live['B'] = '2'
    expect(await provider.base()).toEqual({ env: { A: '1', B: '2' }, warnings: [] })
  })

  it('returns a new object each time, so a caller cannot change the next result', async () => {
    const provider = createWindowsEnvProvider({ inherited: { A: '1' } })
    const first = (await provider.base()).env as Record<string, string>
    first['A'] = 'changed'
    expect((await provider.base()).env).toEqual({ A: '1' })
  })
})
