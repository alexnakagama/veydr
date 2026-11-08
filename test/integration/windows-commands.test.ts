import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { compilerPath, HELPER_PATH } from '../../scripts/build-windows-helper.mjs'
import { SpawnError } from '../../src/main/platform/errors'
import type { CommandSpec, Env, ExitInfo, ManagedProcess, ResolveResult, SpawnPlan } from '../../src/main/platform/types'
import { createWindowsEnvProvider } from '../../src/main/platform/windows/environment'
import { createWindowsProcessTree } from '../../src/main/platform/windows/process-tree'
import { createWindowsCommandResolver, systemCmdExe } from '../../src/main/platform/windows/resolver'
import { editorArguments } from '../../src/main/projects/desktop'
import { effectiveEnvironment } from '../../src/main/projects/environment'
import { collect, consolesOf, helpersOf, isInJob, marked, powershell, waitUntil } from './support/windows'
import type { EditorHostOptions } from './support/windows-editor-host'

// Windows commands through the resolver, the command lines and the real helper
// (add-windows-environment-and-commands designs D2, D4 and D5). The shim corpus and the plain batch
// file (group 2) are in windows-process-tree.test.ts, which keeps no `it.todo` of its own
// (workflow-policy.test.ts); groups 4 and 5 implement the placeholders left here.

const RECORD_ARGS = resolve(__dirname, '../fixtures/windows/record-args.mjs')
const PRINT_ENV = resolve(__dirname, '../fixtures/windows/print-env.mjs')
const GUI_RECORDER_SOURCE = resolve(__dirname, '../fixtures/windows/gui-recorder.cs')
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

  describe('the environment (design D3)', () => {
    /**
     * Veydr's environment as the provider would inherit it, with the entries D3 is about: two
     * spellings of the path variable, runtime variables in two spellings, and a per-drive entry.
     */
    function inheritedWith(s: Scenario, first: string): Record<string, string | undefined> {
      const env: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH' && !/^ELECTRON_/i.test(key)) env[key] = value
      return {
        ...env,
        Path: first,
        PATH: join(s.dir, 'second'),
        ELECTRON_RUN_AS_NODE: '1',
        electron_no_attach_console: '1',
        '=C:': 'C:\\',
        VEYDR_RECORD_FILE: s.record,
      }
    }

    /** The environment a command started with `env` sees, as [name, value] pairs. */
    async function seenBy(s: Scenario, env: Env): Promise<[string, string][]> {
      const spec = direct(s, process.execPath, [PRINT_ENV, '--marker', s.marker])
      const plan = planOf(await resolver.resolve(spec, env))
      expect(await exitOf(await tree.spawn(plan))).toEqual({ code: 0, signal: null, forced: false })
      return JSON.parse(readFileSync(s.record, 'utf8')) as [string, string][]
    }

    it('[spec:project-registry/windows-base-environment] a started command sees exactly one path variable, the first spelling, and no ELECTRON_* variable', async () => {
      const s = scenario()
      const first = `${join(s.dir, 'first')};${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32`
      const { env } = await createWindowsEnvProvider({ inherited: inheritedWith(s, first) }).base()
      const seen = await seenBy(s, effectiveEnvironment(env, [], 'case-insensitive'))
      expect(seen.filter(([name]) => name.toUpperCase() === 'PATH')).toEqual([['Path', first]])
      expect(seen.filter(([name]) => /^ELECTRON_/i.test(name))).toEqual([])
      expect(seen.filter(([name]) => name.startsWith('='))).toEqual([])
    })

    it('[spec:project-registry/override-differing-in-case-on-windows] a PATH override reaches the command as its only path variable', async () => {
      const s = scenario()
      const { env } = await createWindowsEnvProvider({ inherited: inheritedWith(s, join(s.dir, 'first')) }).base()
      const override = join(s.dir, 'override')
      const seen = await seenBy(s, effectiveEnvironment(env, [{ key: 'PATH', value: override, secret: false }], 'case-insensitive'))
      expect(seen.filter(([name]) => name.toUpperCase() === 'PATH')).toEqual([['PATH', override]])
    })
  })

  describe('the editor launch (design D4)', () => {
    let fixtureDir: string
    let guiRecorder: string
    let hostScript: string
    const hosts: ChildProcess[] = []

    beforeAll(async () => {
      fixtureDir = mkdtempSync(join(tmpdir(), 'veydr-win-editor-'))
      // A GUI-subsystem program, as Code.exe is: compiled with the compiler the helper is built with.
      guiRecorder = join(fixtureDir, 'gui-recorder.exe')
      const compiled = spawnSync(compilerPath(), ['/nologo', '/warnaserror+', '/target:winexe', `/out:${guiRecorder}`, GUI_RECORDER_SOURCE], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
      })
      if (compiled.status !== 0) throw new Error(`gui-recorder.cs did not compile: ${compiled.error?.message ?? ''}${compiled.stdout}${compiled.stderr}`)
      // The host imports the TypeScript sources; bundle it into one CommonJS file Node can run.
      await build({
        configFile: false,
        logLevel: 'silent',
        ssr: { noExternal: true },
        build: {
          ssr: join(__dirname, 'support/windows-editor-host.ts'),
          outDir: join(fixtureDir, 'host'),
          emptyOutDir: true,
          minify: false,
          rolldownOptions: { output: { format: 'cjs', entryFileNames: 'editor-host.cjs' } },
        },
      })
      hostScript = join(fixtureDir, 'host', 'editor-host.cjs')
    }, 180_000)
    afterAll(() => {
      rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    afterEach(() => {
      for (const host of hosts.splice(0)) host.kill()
    })

    interface Editor {
      /** The project folder, its name holding spaces, `&` and `^`, and the scenario's marker. */
      readonly project: string
      /** What **Open in editor** plans for it: `code`, found as `code.cmd` on `Path`, through cmd.exe. */
      readonly plan: SpawnPlan
      /** What the program behind `code.cmd` should receive. */
      readonly args: readonly string[]
    }

    const INJECTED = 'veydr-injected'
    /**
     * How long the launched programs stay alive: far longer than the checks below take, each of
     * which starts PowerShell and compiles a type; the scenario cleanup ends them early.
     */
    const LINGER_MS = 60_000

    /**
     * A project and a `code.cmd` holding `lines`, planned as Veydr's **Open in editor** plans it.
     * Were the project path's `&` to reach cmd.exe as a command separator, `mkdir veydr-injected`
     * would run in the project folder.
     */
    async function editor(s: Scenario, lines: readonly string[], lingerMs: number): Promise<Editor> {
      const project = join(s.dir, `My Project & mkdir ${INJECTED} ^ ${s.marker}`)
      mkdirSync(project)
      const bin = join(s.dir, 'editor bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'code.cmd'), lines.map((line) => `${line}\r\n`).join(''))
      const inherited = { ...s.env(bin), VEYDR_LINGER_MS: String(lingerMs) }
      const { env } = await createWindowsEnvProvider({ inherited }).base()
      const args = editorArguments(['--reuse-window', '{path}'], project)
      const plan = planOf(
        await resolver.resolve({ mode: 'direct', file: 'code', args, script: '', shellPath: null, projectRoot: project, cwd: '.' }, effectiveEnvironment(env, [], 'case-insensitive')),
      )
      expect(plan.file).toBe(CMD_EXE)
      return { project, plan, args }
    }

    /** The launched tree's processes: cmd.exe and the program, both carrying the marker. */
    const launched = (s: Scenario, exclude: readonly number[] = []): number[] =>
      marked(s.marker)
        .filter((p) => !exclude.includes(p.pid))
        .map((p) => p.pid)

    const recorded = (s: Scenario): unknown => JSON.parse(readFileSync(s.record, 'utf8'))

    function noInjection(s: Scenario, project: string): void {
      expect(existsSync(join(project, INJECTED)), 'an injected command ran in the project folder').toBe(false)
      expect(existsSync(join(s.dir, INJECTED)), 'an injected command ran').toBe(false)
    }

    it('[spec:project-registry/batch-file-editor-on-windows] a .cmd editor receives a project path with spaces, & and ^ as one argument, no other command runs, and no console appears', async () => {
      const s = scenario()
      // As VS Code's code.cmd starts Code.exe, a GUI-subsystem program.
      const { project, plan, args } = await editor(s, [`@"${guiRecorder}" %*`], LINGER_MS)
      // Helpers of earlier tests exit once their command has; none may be left to blur the check below.
      await waitUntil(() => helpersOf([process.pid]).length === 0, 'the helpers of earlier tests to exit')
      await tree.launchDetached(plan)
      await waitUntil(() => existsSync(s.record), 'the editor to record its arguments')
      expect(recorded(s)).toEqual(args)
      expect(args[1]).toBe(project)
      noInjection(s, project)
      // While the editor runs, cmd.exe still waits for it: neither has a console of its own.
      const pids = launched(s)
      // cmd.exe waits for a program a batch file starts, also a GUI one, so both are still running.
      expect(pids.length, 'cmd.exe (waiting for the editor) and the editor are running').toBe(2)
      expect(consolesOf(pids)).toEqual({ hosts: [], windowOwners: [] })
      // No helper takes part in a detached launch.
      expect(helpersOf([process.pid])).toEqual([])
    })

    it('a batch-file editor that starts a console program shows that program\'s console, as documented (the check above can see one)', async () => {
      const s = scenario()
      // Console programs behind the batch file: Node.js records the arguments, then another stays alive for the check.
      const { project, plan, args } = await editor(s, [`@"${process.execPath}" "${RECORD_ARGS}" %*`, `@"${process.execPath}" -e "setTimeout(function(){},${LINGER_MS})" ${s.marker}`], 0)
      await tree.launchDetached(plan)
      await waitUntil(() => existsSync(s.record), 'the editor to record its arguments')
      expect(recorded(s)).toEqual(args)
      noInjection(s, project)
      // Both parts of the check must see it, or the check in the test above proves nothing.
      await waitUntil(() => {
        const consoles = consolesOf(launched(s))
        return consoles.hosts.length > 0 && consoles.windowOwners.length > 0
      }, 'a console host and its console window for the console program', 30_000)
    })

    it('the editor survives the ending of the process that launched it, inside the runner\'s job, while that process\'s supervised command ends', async () => {
      const s = scenario()
      const { plan, args } = await editor(s, [`@"${guiRecorder}" %*`], LINGER_MS)
      // As Veydr does: a supervised command first, so that libuv's kill-on-close job exists and holds its helper.
      const supervised: SpawnPlan = { file: process.execPath, args: ['-e', `setTimeout(function(){},${LINGER_MS})`, s.marker], cwd: s.dir, env: s.env(process.env['PATH'] ?? '') }
      const options: EditorHostOptions = { helperPath: HELPER_PATH, supervised, editor: plan }
      const host = spawn(process.execPath, [hostScript], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
      hosts.push(host)
      if (host.stdin === null || host.stdout === null) throw new Error('the host was started without pipes')
      host.stdin.end(JSON.stringify(options))
      const output = createInterface({ input: host.stdout })
      try {
        expect((await output[Symbol.asyncIterator]().next()).value).toBe('launched')
      } finally {
        output.close()
      }
      await waitUntil(() => existsSync(s.record), 'the editor to record its arguments')
      expect(recorded(s)).toEqual(args)
      const byName = (name: string): number[] =>
        marked(s.marker)
          .filter((p) => p.name.toLowerCase() === name)
          .map((p) => p.pid)
      const [editorPid] = byName('gui-recorder.exe')
      const [shellPid] = byName('cmd.exe')
      expect(editorPid, 'the editor process').toBeDefined()
      expect(shellPid, 'cmd.exe, waiting for the editor').toBeDefined()
      expect(byName('node.exe'), 'the supervised command').toHaveLength(1)
      expect(helpersOf([host.pid as number]), "the supervised command's helper").toHaveLength(1)
      // Recorded, not assumed (design D4): whether the editor ended up in a job, such as the runner's.
      console.info(`[windows-evidence] the detached editor is in a job: ${String(isInJob(editorPid as number))}`)

      const exited = once(host, 'exit')
      execFileSync('taskkill.exe', ['/F', '/PID', String(host.pid)], { windowsHide: true, stdio: 'ignore', timeout: 30_000 })
      await exited
      // The host's job ends its helper, whose job ends the supervised command; the editor is in neither.
      await waitUntil(() => byName('node.exe').length === 0, 'the supervised command to end with the host', 15_000)
      await waitUntil(() => helpersOf([host.pid as number]).length === 0, "the host's helper to end", 15_000)
      expect(byName('gui-recorder.exe'), 'the editor survives').toEqual([editorPid])
      expect(byName('cmd.exe'), 'cmd.exe, waiting for the editor, survives').toEqual([shellPid])
    })

    it('a missing editor rejects with SpawnError, and nothing starts', async () => {
      const s = scenario()
      const missing = join(s.dir, `missing-editor-${s.marker}.exe`)
      const error = await tree.launchDetached({ file: missing, args: [s.dir], cwd: s.dir, env: s.env(process.env['PATH'] ?? '') }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(SpawnError)
      expect(error).toMatchObject({ reason: 'executable-not-found', message: `Executable not found: ${missing}` })
      expect(marked(s.marker)).toEqual([])
    })
  })

  it.todo('[spec:process-logs/console-output-on-windows] a cmd /c echo of non-ASCII text reaches the log unchanged')
})
