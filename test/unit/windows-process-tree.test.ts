import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SpawnError } from '../../src/main/platform/errors'
import type { SpawnPlan } from '../../src/main/platform/types'
import { createWindowsProcessTree, isFullyQualified, runHelperVersion, type WindowsProcessTreeOptions } from '../../src/main/platform/windows/process-tree'
import { PROTOCOL_VERSION } from '../../src/main/platform/windows/protocol'
import { localSockets } from '../support/local-socket'

// The Windows process tree's checks before a command starts (add-windows-process-supervision design
// D5, task 3.2): a missing helper or one that speaks another protocol version is refused, and no
// helper process is started. The run itself is covered by windows-helper-client.test.ts.

let dir: string
let helperPath: string
let sockets: ReturnType<typeof localSockets>
let spawned: { file: string; args: readonly string[] }[]
let versionReads: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veydr-wpt-'))
  helperPath = join(dir, 'veydr-helper.exe')
  writeFileSync(helperPath, 'not really a helper')
  sockets = localSockets()
  spawned = []
  versionReads = []
})

afterEach(() => {
  sockets.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

/** A helper process that Node failed to create, as `child_process.spawn` reports one. */
function unstartableHelper(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { pid: undefined; stdout: PassThrough; stderr: PassThrough }
  child.pid = undefined
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  setImmediate(() => child.emit('error', new Error('spawn failed in the test')))
  return child as unknown as ChildProcess
}

function options(version: string | (() => Promise<string>) = `${PROTOCOL_VERSION}\r\n`): WindowsProcessTreeOptions {
  return {
    helperPath,
    pipePath: () => sockets.next(),
    readHelperVersion: (path) => {
      versionReads.push(path)
      return typeof version === 'string' ? Promise.resolve(version) : version()
    },
    spawnHelper: (file, args) => {
      spawned.push({ file, args })
      return unstartableHelper()
    },
  }
}

const plan = (): SpawnPlan => ({ file: process.execPath, args: ['server.js'], cwd: dir, env: {} })

async function spawnError(pending: Promise<unknown>): Promise<SpawnError> {
  const error = await pending.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SpawnError)
  return error as SpawnError
}

describe('a missing helper', () => {
  it('rejects with "Windows helper not found" and starts nothing', async () => {
    rmSync(helperPath)
    const error = await spawnError(createWindowsProcessTree(options()).spawn(plan()))
    expect(error).toMatchObject({ reason: 'other', message: `Windows helper not found: ${helperPath}` })
    expect(versionReads).toEqual([])
    expect(spawned).toEqual([])
  })

  it('treats a directory in the helper\'s place as missing', async () => {
    rmSync(helperPath)
    mkdirSync(helperPath)
    const error = await spawnError(createWindowsProcessTree(options()).spawn(plan()))
    expect(error.message).toBe(`Windows helper not found: ${helperPath}`)
    expect(spawned).toEqual([])
  })
})

describe('the helper path', () => {
  it('must be absolute, so that it is never looked up on PATH', async () => {
    const error = await spawnError(createWindowsProcessTree({ ...options(), helperPath: 'veydr-helper.exe' }).spawn(plan()))
    expect(error).toMatchObject({ reason: 'other', message: 'The Windows helper path must be absolute: veydr-helper.exe' })
    expect(versionReads).toEqual([])
    expect(spawned).toEqual([])
  })
})

describe('full paths', () => {
  it('accept a drive path or a UNC path, as the helper does', () => {
    for (const path of ['C:\\Program Files\\nodejs\\node.exe', 'c:/tools/node.exe', '\\\\server\\share\\node.exe', '//server/share/node.exe']) {
      expect(isFullyQualified(path), path).toBe(true)
    }
  })

  it('refuse a drive-relative, root-relative, or bare path', () => {
    for (const path of ['C:node.exe', '\\node.exe', '\\\\', 'node.exe', '.\\node.exe', '']) {
      expect(isFullyQualified(path), path).toBe(false)
    }
  })
})

describe('the helper\'s protocol version', () => {
  it('rejects a helper that speaks another version, and starts no run', async () => {
    const error = await spawnError(createWindowsProcessTree(options('2\n')).spawn(plan()))
    expect(error).toMatchObject({
      reason: 'other',
      message: `The Windows helper ${helperPath} speaks protocol version 2, but Veydr needs version ${PROTOCOL_VERSION}`,
    })
    expect(versionReads).toEqual([helperPath])
    expect(spawned).toEqual([])
  })

  it('shows unexpected version output quoted and shortened', async () => {
    const error = await spawnError(createWindowsProcessTree(options(`usage: veydr-helper ${'x'.repeat(100)}`)).spawn(plan()))
    expect(error.message).toBe(`The Windows helper ${helperPath} speaks protocol version ${JSON.stringify(`usage: veydr-helper ${'x'.repeat(20)}`)}, but Veydr needs version ${PROTOCOL_VERSION}`)
    expect(spawned).toEqual([])
  })

  it('rejects a helper that cannot report its version', async () => {
    const error = await spawnError(createWindowsProcessTree(options(() => Promise.reject(new Error('exited with 2')))).spawn(plan()))
    expect(error.message).toBe(`The Windows helper ${helperPath} could not report its protocol version: exited with 2`)
    expect(spawned).toEqual([])
  })

  it('runs the real version command, which fails for a file that is no program', async () => {
    await expect(runHelperVersion(helperPath)).rejects.toThrow()
  })

  it('starts the run once the version matches', async () => {
    const error = await spawnError(createWindowsProcessTree(options()).spawn(plan()))
    // The fake helper could not be started; what matters is that the run was attempted.
    expect(error.message).toBe(`Could not start the Windows helper ${helperPath}: spawn failed in the test`)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.file).toBe(helperPath)
    expect(spawned[0]?.args.slice(2)).toEqual([process.execPath, 'server.js'])
  })

  it('reads the version once per helper file, and again after the file changes', async () => {
    const tree = createWindowsProcessTree(options())
    await Promise.all([spawnError(tree.spawn(plan())), spawnError(tree.spawn(plan()))])
    await spawnError(tree.spawn(plan()))
    expect(versionReads).toHaveLength(1)

    writeFileSync(helperPath, 'a rebuilt helper')
    utimesSync(helperPath, new Date(), new Date(Date.now() + 60_000))
    await spawnError(tree.spawn(plan()))
    expect(versionReads).toHaveLength(2)
    expect(spawned).toHaveLength(4)
  })

  it('does not remember a failed check', async () => {
    let answer = Promise.reject<string>(new Error('busy'))
    answer.catch(() => undefined)
    const tree = createWindowsProcessTree(options(() => answer))
    await spawnError(tree.spawn(plan()))
    answer = Promise.resolve(`${PROTOCOL_VERSION}\n`)
    await spawnError(tree.spawn(plan()))
    expect(versionReads).toHaveLength(2)
    expect(spawned).toHaveLength(1)
  })
})

describe('the command', () => {
  const failure = async (overrides: Partial<SpawnPlan>): Promise<SpawnError> => {
    const error = await spawnError(createWindowsProcessTree(options()).spawn({ ...plan(), ...overrides }))
    expect(spawned).toEqual([])
    return error
  }

  it('must be given by its full path', async () => {
    expect(await failure({ file: 'node.exe' })).toMatchObject({ reason: 'executable-not-found', message: 'Executable not found: node.exe (a full path is needed)' })
  })

  it('must exist and be a file', async () => {
    const missing = join(dir, 'missing.exe')
    expect(await failure({ file: missing })).toMatchObject({ reason: 'executable-not-found', message: `Executable not found: ${missing}` })
    expect(await failure({ file: dir })).toMatchObject({ reason: 'not-executable', message: `Not an executable file: ${dir}` })
  })

  it('needs an existing working directory, reported as such rather than as a missing helper', async () => {
    const gone = join(dir, 'gone')
    expect(await failure({ cwd: gone })).toMatchObject({ reason: 'cwd-missing', message: `Working directory does not exist: ${gone}` })
    expect(await failure({ cwd: helperPath })).toMatchObject({ reason: 'cwd-not-directory', message: `Working directory is not a directory: ${helperPath}` })
  })

  it('may not contain a NUL character', async () => {
    expect(await failure({ args: ['a\0b'] })).toMatchObject({ reason: 'other', message: `Could not start ${process.execPath}: the command contains a NUL character` })
  })
})

it('checks the helper before the command', async () => {
  rmSync(helperPath)
  const error = await spawnError(createWindowsProcessTree(options()).spawn({ ...plan(), cwd: join(dir, 'gone') }))
  expect(error.message).toBe(`Windows helper not found: ${helperPath}`)
})
