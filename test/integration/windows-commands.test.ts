import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HELPER_PATH } from '../../scripts/build-windows-helper.mjs'
import type { CommandSpec, Env, ExitInfo, ManagedProcess, ResolveResult, SpawnPlan } from '../../src/main/platform/types'
import { createWindowsProcessTree } from '../../src/main/platform/windows/process-tree'
import { createWindowsCommandResolver, systemCmdExe } from '../../src/main/platform/windows/resolver'
import { collect, helpersOf, marked, powershell, waitUntil } from './support/windows'

// Windows commands through the resolver, the command lines and the real helper
// (add-windows-environment-and-commands designs D2, D4 and D5). The shim corpus and the plain batch
// file (group 2) are in windows-process-tree.test.ts, which keeps no `it.todo` of its own
// (workflow-policy.test.ts); groups 4 and 5 implement the placeholders left here.

const RECORD_ARGS = resolve(__dirname, '../fixtures/windows/record-args.mjs')
const CMD_EXE = systemCmdExe(process.env['SystemRoot'])
const SENTINEL = 'veydr-decoy-ran'

/**
 * An App Execution Alias of this user (a zero-byte reparse point in `WindowsApps`), if there is
 * one; the resolver must find it with `lstat` (design D2). Read before the tests are collected, so
 * that a test without one says so in its title.
 */
function appExecutionAlias(): { readonly directory: string; readonly name: string } | null {
  const local = process.env['LOCALAPPDATA']
  if (local === undefined) return null
  const directory = join(local, 'Microsoft', 'WindowsApps')
  try {
    const name = readdirSync(directory).find((entry) => /^(?:winget|python3?|wt)\.exe$/i.test(entry))
    return name === undefined ? null : { directory, name: name.slice(0, -'.exe'.length) }
  } catch {
    return null
  }
}
const ALIAS = appExecutionAlias()

interface Scenario {
  /** The project folder, its real path. */
  readonly dir: string
  readonly marker: string
  readonly record: string
  /** Veydr's environment with `PATH` replaced (one entry, whatever its case) and the record file set. */
  env(path: string): Env
}

const exitOf = (run: ManagedProcess): Promise<ExitInfo> => new Promise((done) => run.onExit(done))

describe.skipIf(process.platform !== 'win32')('[windows-only: cmd.exe and PATHEXT]', () => {
  const tree = createWindowsProcessTree({ helperPath: HELPER_PATH })
  const resolver = createWindowsCommandResolver({ cmdExe: CMD_EXE })
  const scenarios: Scenario[] = []

  afterEach(() => {
    const list = scenarios.splice(0)
    if (list.length === 0) return
    const markers = list.map((s) => `'${s.marker}'`).join(',')
    powershell(
      `$markers = @(${markers})
       Get-CimInstance Win32_Process | Where-Object {
         $line = $_.CommandLine
         $_.ProcessId -ne $PID -and $null -ne $line -and @($markers | Where-Object { $line.Contains($_) }).Count -gt 0
       } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    )
    for (const s of list) rmSync(s.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  function scenario(): Scenario {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'veydr-wincmd-')))
    const marker = randomUUID()
    const record = join(dir, 'record.json')
    const s: Scenario = {
      dir,
      marker,
      record,
      env(path) {
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key.toUpperCase() !== 'PATH') env[key] = value
        return { ...env, PATH: path, VEYDR_RECORD_FILE: record }
      },
    }
    scenarios.push(s)
    return s
  }

  const direct = (s: Scenario, file: string, args: readonly string[]): CommandSpec => ({ mode: 'direct', file, args, script: '', shellPath: null, projectRoot: s.dir, cwd: '.' })

  function planOf(result: ResolveResult): SpawnPlan {
    if (!result.ok) throw new Error(`refused: ${result.diagnostics.join(' | ')}`)
    return result.plan
  }

  /** A directory holding an `npm.cmd`-style shim that forwards `%*` to the recorder, and an extensionless `npm` beside it, as Node.js installs. */
  function npmDirectory(s: Scenario): string {
    const bin = join(s.dir, 'node')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm.cmd'), `@"${process.execPath}" "${RECORD_ARGS}" %*\r\n`)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 3\n')
    return bin
  }

  it('has the built helper', () => {
    expect(existsSync(HELPER_PATH), `${HELPER_PATH} (run node scripts/build-windows-helper.mjs)`).toBe(true)
  })

  it('[spec:project-registry/program-found-through-pathext] resolves npm to an npm.cmd on PATH and starts it', async () => {
    const s = scenario()
    const bin = npmDirectory(s)
    const args = ['run', 'dev', '--', 'a b', 'x&y', s.marker]
    const plan = planOf(await resolver.resolve(direct(s, 'npm', args), s.env(bin)))
    expect(plan.file).toBe(CMD_EXE)
    expect(plan.commandLine).toContain(`"${join(bin, 'npm.CMD')}"`)
    expect(await exitOf(await tree.spawn(plan))).toEqual({ code: 0, signal: null, forced: false })
    expect(JSON.parse(readFileSync(s.record, 'utf8'))).toEqual(args)
  })

  it('[spec:project-registry/working-directory-not-searched] never runs a decoy npm.cmd from the working directory', async () => {
    const s = scenario()
    writeFileSync(join(s.dir, 'npm.cmd'), `@type nul>"%~dp0${SENTINEL}"\r\n`)
    // Not on PATH: refused, naming the program.
    const refused = await resolver.resolve(direct(s, 'npm', [s.marker]), s.env(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')))
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.diagnostics[0]).toMatch(/^Executable not found: npm /)
    // On PATH too: the one on PATH runs.
    const plan = planOf(await resolver.resolve(direct(s, 'npm', [s.marker]), s.env(npmDirectory(s))))
    expect(await exitOf(await tree.spawn(plan))).toEqual({ code: 0, signal: null, forced: false })
    expect(JSON.parse(readFileSync(s.record, 'utf8'))).toEqual([s.marker])
    expect(existsSync(join(s.dir, SENTINEL)), 'the decoy ran').toBe(false)
  })

  it('[spec:project-registry/cmd-exe-script-runs] runs a cmd.exe script with && and %VARIABLE% and prints its result', async () => {
    const s = scenario()
    const spec: CommandSpec = {
      mode: 'shell',
      file: '',
      args: [],
      script: `echo %VEYDR_GREETING%&& echo ${s.marker}|| echo not reached`,
      shellPath: CMD_EXE,
      projectRoot: s.dir,
      cwd: '.',
    }
    const plan = planOf(await resolver.resolve(spec, { ...s.env(process.env['PATH'] ?? ''), VEYDR_GREETING: 'hello' }))
    const run = await tree.spawn(plan)
    const [stdout, exit] = await Promise.all([collect(run.stdout), exitOf(run)])
    expect(exit).toEqual({ code: 0, signal: null, forced: false })
    expect(stdout.toString('utf8')).toBe(`hello\r\n${s.marker}\r\n`)
  })

  it(
    ALIAS === null
      ? 'finds an App Execution Alias: none on this runner, so this run is no evidence'
      : `finds the App Execution Alias ${ALIAS.name}.exe in WindowsApps with lstat`,
    async () => {
      const s = scenario()
      if (ALIAS === null) {
        expect(ALIAS).toBeNull()
        return
      }
      expect(planOf(await resolver.resolve(direct(s, ALIAS.name, []), s.env(ALIAS.directory))).file.toLowerCase()).toBe(join(ALIAS.directory, `${ALIAS.name}.EXE`).toLowerCase())
    },
  )

  // The resolver never spawns, so the process and helper counts below hold by construction; the
  // refusals themselves are the check, and the counts guard against a resolver that one day does.
  it('refuses these inputs while planning, so no process or helper is created for them', async () => {
    const s = scenario()
    writeFileSync(join(s.dir, 'tool.ps1'), `Write-Output ${s.marker}\r\n`)
    writeFileSync(join(s.dir, 'tool.exe'), '')
    const powershellExe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const shell = (script: string, shellPath: string): CommandSpec => ({ mode: 'shell', file: '', args: [], script, shellPath, projectRoot: s.dir, cwd: '.' })
    const refused: [string, CommandSpec][] = [
      ['another shell', shell(`echo ${s.marker}`, powershellExe)],
      ['a multi-line script', shell(`echo ${s.marker}\r\necho again`, CMD_EXE)],
      ['an unsupported program type', direct(s, '.\\tool.ps1', [s.marker])],
      ['a drive-relative path', direct(s, `${s.dir.slice(0, 2)}tool.exe`, [s.marker])],
      ['a root-relative path', direct(s, `${s.dir.slice(2)}\\tool.exe`, [s.marker])],
      ['a batch argument with a line break', direct(s, 'npm', [s.marker, 'one\ntwo'])],
    ]
    const env = s.env(npmDirectory(s))
    // Helpers of earlier tests exit once their command has; none may be left to blur the count.
    await waitUntil(() => helpersOf([process.pid]).length === 0, 'the helpers of earlier tests to exit')
    for (const [what, spec] of refused) expect((await resolver.resolve(spec, env)).ok, what).toBe(false)
    expect(marked(s.marker)).toEqual([])
    expect(helpersOf([process.pid])).toEqual([])
    expect(existsSync(s.record)).toBe(false)
  })

  it.todo('[spec:project-registry/batch-file-editor-on-windows] a .cmd editor receives a project path with spaces, & and ^ as one argument, with no new console window')
  it.todo('[spec:process-logs/console-output-on-windows] a cmd /c echo of non-ASCII text reaches the log unchanged')
})
