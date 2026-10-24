import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopActions } from '../../src/main/projects/desktop'
import { createLinuxEnvProvider, LOGIN_SHELL_TIMEOUT_MS } from '../../src/main/platform/linux/environment'
import { SpawnError } from '../../src/main/platform/errors'
import { createCleanSpawner, findExecWrapper, WRAPPER_UNAVAILABLE, wrappedCommand } from '../../src/main/platform/linux/executable'
import { createLinuxProcessTree } from '../../src/main/platform/linux/process-tree'
import { createLinuxCommandResolver } from '../../src/main/platform/linux/resolver'
import type { CommandSpec, Env, ManagedProcess, SpawnPlan } from '../../src/main/platform/types'
import type { Config } from '../../src/shared/config'
import { fixture, readProcess, scenario, taggedProcesses, TAG_VARIABLE, waitUntil, type Scenario } from '../support/proc'

const scenarios: Scenario[] = []
afterEach(() => {
  for (const s of scenarios.splice(0)) s.cleanup()
})
function track(): Scenario {
  const s = scenario()
  scenarios.push(s)
  return s
}

const resolver = createLinuxCommandResolver()
const exitOf = (run: ManagedProcess): Promise<unknown> => new Promise((done) => run.onExit(done))

function direct(projectRoot: string, file: string, args: readonly string[], cwd = '.'): CommandSpec {
  return { mode: 'direct', file, args, script: '', shellPath: null, projectRoot, cwd }
}

async function planned(spec: CommandSpec, env: Env): Promise<SpawnPlan> {
  const result = await resolver.resolve(spec, env)
  if (!result.ok) throw new Error(result.diagnostics.join(' '))
  return result.plan
}

/** Runs `plan` through the Linux process tree and returns what the inspect fixture reported. */
async function inspect(plan: SpawnPlan, out: string): Promise<{ argv: string[]; env: Record<string, string>; cwd: string }> {
  const run = await createLinuxProcessTree().spawn(plan)
  await exitOf(run)
  return JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; env: Record<string, string>; cwd: string }
}

/** Arguments a shell would interpret; direct mode must pass them on unchanged. */
const LITERAL_ARGUMENTS = ['a b', '"double quoted"', "'single quoted'", '$HOME', '${PATH}', '$(echo injected)', '`id`', ';', 'a;b', '&', 'a&&b', '|', 'a|b', '*', '*.mjs', '~', '\\', 'new\nline', '']

describe('Linux command resolver', () => {
  it('[spec:project-registry/arguments-passed-literally] passes arguments with spaces, quotes, $, ;, &, |, * to a PATH-resolved executable unchanged', async () => {
    const s = track()
    const bin = join(s.dir, 'bin')
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, 'veydr-test-node'))
    const out = join(s.dir, 'out.json')
    const env = { ...s.env, PATH: `${bin}:/usr/bin:/bin` }
    const plan = await planned(direct(s.dir, 'veydr-test-node', [fixture('inspect'), '--out', out, '--', ...LITERAL_ARGUMENTS]), env)
    expect(plan.file).toBe(join(bin, 'veydr-test-node'))
    const seen = await inspect(plan, out)
    expect(seen.argv).toEqual(LITERAL_ARGUMENTS)
    expect(seen.env['PATH']).toBe(env.PATH)
    expect(seen.env[TAG_VARIABLE]).toBe(s.tag)
  })

  it('[spec:project-registry/executable-not-found] names an executable that is not on PATH or not at its path', async () => {
    const s = track()
    expect(await resolver.resolve(direct(s.dir, 'veydr-no-such-executable', []), { PATH: '/usr/bin:/bin' })).toEqual({
      ok: false,
      diagnostics: ['Executable not found: veydr-no-such-executable (searched PATH)'],
    })
    expect(await resolver.resolve(direct(s.dir, './bin/missing', []), {})).toEqual({ ok: false, diagnostics: ['Executable not found: ./bin/missing'] })
    writeFileSync(join(s.dir, 'script.sh'), '#!/bin/sh\n', { mode: 0o644 })
    expect(await resolver.resolve(direct(s.dir, './script.sh', []), {})).toEqual({ ok: false, diagnostics: ['Permission denied: ./script.sh is not executable'] })
  })

  it('[spec:project-registry/working-directory-outside-project-rejected] rejects a working directory outside the project folder, also through a symbolic link', async () => {
    const s = track()
    const root = join(s.dir, 'project')
    mkdirSync(join(root, 'api'), { recursive: true })
    symlinkSync(s.dir, join(root, 'escape'))
    for (const cwd of ['..', 'api/../..', '../project/../..']) {
      expect(await resolver.resolve(direct(root, process.execPath, [], cwd), {}), cwd).toEqual({
        ok: false,
        diagnostics: [`The working directory "${cwd}" is outside the project folder ${root}`],
      })
    }
    expect(await resolver.resolve(direct(root, process.execPath, [], 'escape'), {})).toEqual({
      ok: false,
      diagnostics: [`The working directory "escape" is outside the project folder ${root} (it resolves to ${s.dir})`],
    })
    // Inside: the plan uses the resolved directory.
    expect(await planned(direct(root, process.execPath, [], 'api'), {})).toMatchObject({ cwd: join(root, 'api') })
    expect(await resolver.resolve(direct(root, process.execPath, [], 'nope'), {})).toEqual({ ok: false, diagnostics: [`Working directory does not exist: ${join(root, 'nope')}`] })
  })

  it('[spec:project-registry/directory-missing] refuses to start a command whose project folder is missing', async () => {
    const s = track()
    const gone = join(s.dir, 'gone')
    expect(await resolver.resolve(direct(gone, process.execPath, []), {})).toEqual({ ok: false, diagnostics: [`The project folder is missing: ${gone}`] })
  })

  it('runs shell mode through the configured shell', async () => {
    const s = track()
    const out = join(s.dir, 'out.txt')
    const plan = await planned({ mode: 'shell', file: '', args: [], script: `printf '%s' "$0" > '${out}'`, shellPath: '/bin/sh', projectRoot: s.dir, cwd: '.' }, s.env)
    expect(plan).toMatchObject({ file: '/bin/sh', args: ['-c', `printf '%s' "$0" > '${out}'`] })
    await exitOf(await createLinuxProcessTree().spawn(plan))
    expect(readFileSync(out, 'utf8')).toBe('/bin/sh')
  })
})

describe('Linux exec wrapper', () => {
  it('leaves a started program only descriptors 0–2, even when the parent holds inheritable descriptors above 9', async () => {
    const wrapper = await findExecWrapper()
    expect(wrapper, 'bash and env are required on the supported distributions').not.toBeNull()
    if (wrapper === null) return
    const command = wrappedCommand(wrapper, '/bin/sh', ['-c', 'ls /proc/$$/fd | sort -n | tr "\\n" " "'], { PATH: '/usr/bin:/bin' })
    // Descriptors 3–12 of this child are pipes without close-on-exec (libuv dup2s them), like
    // Electron's Chromium descriptors.
    const child = spawn(command.file, command.args, { stdio: ['ignore', 'pipe', 'pipe', ...Array<'pipe'>(10).fill('pipe')], env: {} })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    await new Promise((done) => child.on('close', done))
    expect(output.trim()).toBe('0 1 2')
  })

  it('passes the environment exactly, including names a shell cannot export, and runs a path containing "="', async () => {
    const s = track()
    const wrapper = await findExecWrapper()
    if (wrapper === null) throw new Error('exec wrapper unavailable')
    const dir = join(s.dir, 'a=b')
    mkdirSync(dir)
    symlinkSync(process.execPath, join(dir, 'node'))
    const out = join(s.dir, 'out.json')
    const env = { 'BASH_FUNC_x%%': '() { echo hi; }', SHELLOPTS: 'xtrace', 'odd.name': 'v', [TAG_VARIABLE]: s.tag }
    const command = wrappedCommand(wrapper, join(dir, 'node'), [fixture('inspect'), '--out', out], env)
    const child = spawn(command.file, command.args, { stdio: ['ignore', 'pipe', 'pipe'], env: {} })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    await new Promise((done) => child.on('close', done))
    expect(stderr).toBe('')
    expect((JSON.parse(readFileSync(out, 'utf8')) as { env: Record<string, string> }).env).toEqual(env)
  })
})

describe('Linux exec wrapper failures (L5 review)', () => {
  it('starts nothing without bash or env (fail closed)', async () => {
    let spawned = 0
    let told = 0
    const spawner = createCleanSpawner(
      () => {
        spawned++
        throw new Error('must not spawn')
      },
      () => told++,
      () => Promise.resolve(null),
    )
    for (let i = 0; i < 2; i++) {
      await expect(spawner.spawn(process.execPath, [], { env: {} })).rejects.toEqual(new SpawnError('other', WRAPPER_UNAVAILABLE))
    }
    expect(spawned).toBe(0)
    expect(told).toBe(1)
  })

  it('refuses a path containing "=" when nice is not installed', () => {
    expect(() => wrappedCommand({ bash: '/bin/bash', env: '/usr/bin/env', nice: null }, '/opt/a=b/x', [], {})).toThrow(SpawnError)
    expect(wrappedCommand({ bash: '/bin/bash', env: '/usr/bin/env', nice: null }, '/opt/x', ['a'], { K: 'v' }).args.slice(-3)).toEqual(['K=v', '/opt/x', 'a'])
  })

  it('reports a script whose #! interpreter is missing as a start failure', async () => {
    const s = track()
    writeFileSync(join(s.dir, 'tool'), '#!/veydr/no/such/interpreter -x\necho hi\n', { mode: 0o755 })
    expect(await resolver.resolve(direct(s.dir, './tool', []), {})).toEqual({
      ok: false,
      diagnostics: ['Interpreter not found: /veydr/no/such/interpreter (named on the first line of ./tool)'],
    })
    await expect(createLinuxProcessTree().launchDetached({ file: join(s.dir, 'tool'), args: [], cwd: s.dir, env: {} })).rejects.toMatchObject({ reason: 'executable-not-found' })
  })

  it('reports an executable that disappears after the check as a run that exits with status 127 (documented)', async () => {
    const s = track()
    const file = join(s.dir, 'vanishing')
    symlinkSync(process.execPath, file)
    const tree = createLinuxProcessTree({
      spawnChild: (wrapper, args, options) => {
        rmSync(file)
        return spawn(wrapper, args, options)
      },
    })
    const run = await tree.spawn({ file, args: [], cwd: s.dir, env: { [TAG_VARIABLE]: s.tag } })
    expect(await exitOf(run)).toMatchObject({ code: 127, signal: null })
  })
})

describe('Linux login environment', () => {
  /** A temporary HOME whose bash login file is `profile`. */
  function home(s: Scenario, profile: string): Record<string, string> {
    const dir = join(s.dir, 'home')
    mkdirSync(dir)
    writeFileSync(join(dir, '.bash_profile'), profile)
    return { HOME: dir, PATH: '/usr/bin:/bin', [TAG_VARIABLE]: s.tag, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', CHROME_DESKTOP: 'veydr.desktop', NO_AT_BRIDGE: '1', APPIMAGE: '/tmp/x.AppImage' }
  }

  it('[spec:project-registry/desktop-launch-resolves-login-path] reads the login shell environment, ignoring noise, with standard input not connected', async () => {
    const s = track()
    const inherited = home(
      s,
      [
        'echo "welcome banner on stdout"',
        'echo "warning on stderr" >&2',
        'printf "__VEYDR_ENV_START_fake__"',
        'read -r line; echo "stdin gave [$line]"',
        'export PATH="$HOME/bin:$PATH"',
        'export VEYDR_LOGIN_VARIABLE="from profile"',
        '',
      ].join('\n'),
    )
    const started = Date.now()
    const { env, warnings } = await createLinuxEnvProvider({ inherited, shell: '/bin/bash' }).base()
    expect(warnings).toEqual([])
    expect(Date.now() - started).toBeLessThan(LOGIN_SHELL_TIMEOUT_MS)
    // The system profile may set PATH first; the user's profile adds to it.
    expect(env['PATH']).toMatch(new RegExp(`^${inherited['HOME']}/bin:`))
    expect(env['VEYDR_LOGIN_VARIABLE']).toBe('from profile')
    expect(env['HOME']).toBe(inherited['HOME'])
    expect(Object.keys(env).filter((key) => key.startsWith('ELECTRON_') || ['CHROME_DESKTOP', 'NO_AT_BRIDGE', 'APPIMAGE', 'PWD', 'OLDPWD', '_'].includes(key))).toEqual([])
  })

  it('[spec:project-registry/login-shell-resolution-fails] falls back to the inherited environment without runtime variables when the login shell hangs, and ends it', async () => {
    const s = track()
    const inherited = home(s, 'export VEYDR_LOGIN_VARIABLE=1\nsleep 60\n')
    const { env, warnings } = await createLinuxEnvProvider({ inherited, shell: '/bin/bash', timeoutMs: 1_000 }).base()
    expect(env).toEqual({ HOME: inherited['HOME'] ?? '', PATH: '/usr/bin:/bin', [TAG_VARIABLE]: s.tag })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no result within 1 s')
    // The hanging shell and its `sleep` were ended.
    await waitUntil(() => taggedProcesses(s.tag).length === 0, 'login shell ended')
  })

  it('falls back with a warning when the login shell fails', async () => {
    const s = track()
    const inherited = home(s, 'exit 3\n')
    const { env, warnings } = await createLinuxEnvProvider({ inherited, shell: '/bin/bash' }).base()
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    expect(warnings[0]).toContain('exited with status 3 without printing the environment')
    const missing = await createLinuxEnvProvider({ inherited, shell: join(s.dir, 'no-shell') }).base()
    expect(missing.warnings).toHaveLength(1)
  })

  it('uses a 5 s timeout by default', () => {
    expect(LOGIN_SHELL_TIMEOUT_MS).toBe(5_000)
  })
})

describe('desktop actions', () => {
  function setup(s: Scenario, projectPath: string, editorArgs: readonly string[]) {
    const out = join(s.dir, 'editor-args.txt')
    const editor = join(s.dir, 'fake-editor')
    // Records its arguments (one per line, NUL-separated to keep newlines) and keeps running like an editor.
    writeFileSync(editor, `#!/bin/sh\nprintf '%s\\0' "$@" > '${out}.tmp' && mv '${out}.tmp' '${out}'\nexec sleep 60\n`)
    chmodSync(editor, 0o755)
    const config: Config = {
      schemaVersion: 1,
      projects: [{ id: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12', name: 'shop', path: projectPath, commands: [] }],
      settings: { editor: { file: editor, args: [...editorArgs] } },
    }
    const opened: string[] = []
    const actions = createDesktopActions({
      config: () => config,
      showDirectoryPicker: () => Promise.resolve(null),
      openPath: (path) => {
        opened.push(path)
        return Promise.resolve('')
      },
      launcher: createLinuxProcessTree(),
      resolver,
      environment: { base: () => Promise.resolve({ env: s.env, warnings: [] }) },
    })
    return { actions, out, opened, projectId: config.projects[0]?.id ?? '' }
  }

  it('[spec:project-registry/launch-editor] starts the editor without a shell, the project path substituted as one argument, unsupervised in its own session', async () => {
    const s = track()
    const project = join(s.dir, `my "project" $HOME; *`)
    mkdirSync(project)
    const { actions, out, projectId } = setup(s, project, ['--new-window', '{path}', '--goto={path}:1'])
    await actions.openInEditor(projectId)
    await waitUntil(() => {
      try {
        readFileSync(out)
        return true
      } catch {
        return false
      }
    }, 'editor started')
    expect(readFileSync(out, 'utf8').split('\0').slice(0, -1)).toEqual(['--new-window', project, `--goto=${project}:1`])
    const [editor] = taggedProcesses(s.tag)
    expect(editor).toBeDefined()
    const info = readProcess(editor?.pid ?? 0)
    // Its own session (so no group signal of Veydr reaches it) and not a child Veydr waits on.
    expect(info?.sid).toBe(editor?.pid)
  })

  it('[spec:project-registry/path-is-not-a-directory] opens nothing when the project path is missing or not a folder', async () => {
    const s = track()
    const file = join(s.dir, 'file')
    writeFileSync(file, '')
    for (const path of [file, join(s.dir, 'missing')]) {
      const { actions, opened, projectId } = setup(s, path, ['{path}'])
      await expect(actions.openFolder(projectId)).rejects.toThrow(`Nothing was opened: the folder of "shop" is missing or not a folder (${path}).`)
      await expect(actions.openInEditor(projectId)).rejects.toThrow('Nothing was opened')
      expect(opened).toEqual([])
    }
    expect(taggedProcesses(s.tag)).toEqual([])
  })

  it('[spec:project-registry/open-existing-folder] opens an existing project folder', async () => {
    const s = track()
    const { actions, opened, projectId } = setup(s, s.dir, ['{path}'])
    await actions.openFolder(projectId)
    expect(opened).toEqual([s.dir])
  })
})
