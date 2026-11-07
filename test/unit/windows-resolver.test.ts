import { win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CommandSpec, Env, PlatformLog, ResolveResult, SpawnPlan } from '../../src/main/platform/types'
import { batchCommandLine, shellCommandLine } from '../../src/main/platform/windows/command-line'
import {
  createWindowsCommandResolver,
  checkKey,
  DEFAULT_PATHEXT,
  MAX_UNANSWERED_DIRECTORIES,
  pathDirectories,
  pathExtensions,
  systemCmdExe,
  type WindowsResolverFs,
} from '../../src/main/platform/windows/resolver'

// The Windows command resolver (add-windows-environment-and-commands design D2), unit-tested with a
// fake filesystem on every system. The real `cmd.exe`, `PATHEXT` and helper run it in
// test/integration/windows-commands.test.ts.

const CMD = 'C:\\Windows\\System32\\cmd.exe'
const PROJECT = 'C:\\Users\\dev\\shop'

/**
 * A file, a directory, or a symbolic link (or junction) that `lstat` reports as a link: to a file,
 * to a directory, to nothing, or one `stat` cannot follow (an App Execution Alias).
 */
type Node = 'file' | 'dir' | 'link-file' | 'link-dir' | 'link-dangling' | 'alias'

interface FakeOptions {
  /** Directories whose every `lstat` waits until `release()`, then fails with `ENOENT`. */
  readonly hang?: readonly string[]
  /** Paths whose every call (`lstat`, `stat`, `realpath`) waits until `release()`. */
  readonly hangPaths?: readonly string[]
  /** Directories (or exact paths) whose every `lstat` fails with this code. */
  readonly fail?: Readonly<Record<string, string>>
  /** Junctions: a path prefix and the path it resolves to. */
  readonly links?: Readonly<Record<string, string>>
}

interface FakeFs extends WindowsResolverFs {
  readonly lstats: string[]
  /** Lets every hung call answer. */
  release(): void
}

/** A case-insensitive fake of the Windows filesystem, recording every `lstat`. */
function fakeFs(nodes: Readonly<Record<string, Node>>, options: FakeOptions = {}): FakeFs {
  const key = (path: string): string => win32.normalize(path).toLowerCase()
  const known = new Map<string, { path: string; node: Node }>()
  const add = (path: string, node: Node): void => {
    known.set(key(path), { path: win32.normalize(path), node })
    const parent = win32.dirname(path)
    if (parent !== path && !known.has(key(parent))) add(parent, 'dir')
  }
  for (const [path, node] of Object.entries(nodes)) add(path, node)
  for (const path of [CMD, PROJECT]) if (!known.has(key(path))) add(path, path === CMD ? 'file' : 'dir')

  const error = (code: string, path: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: ${path}`), { code })
  const under = (path: string, directory: string): boolean => key(win32.dirname(path)) === key(directory)
  let released = false
  const waiting: (() => void)[] = []
  const held = <T>(answer: () => Promise<T>): Promise<T> =>
    new Promise<void>((done) => (released ? done() : waiting.push(done))).then(answer)
  const hung = (path: string): boolean => options.hangPaths?.some((hangPath) => key(hangPath) === key(path)) ?? false
  const lstats: string[] = []
  const info = (node: Node, follow: boolean) => {
    const directory = node === 'dir' || (follow && node === 'link-dir')
    return { isDirectory: () => directory, isSymbolicLink: () => !follow && node.startsWith('link') }
  }
  const lstatOf = (path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }> => {
    const found = known.get(key(path))
    if (found === undefined) return Promise.reject(error('ENOENT', path))
    // An alias is a reparse point that lstat reports as a link.
    return Promise.resolve(found.node === 'alias' ? { isDirectory: () => false, isSymbolicLink: () => true } : info(found.node, false))
  }
  const statOf = (path: string): Promise<{ isDirectory(): boolean }> => {
    const found = known.get(key(path))
    if (found === undefined || found.node === 'link-dangling') return Promise.reject(error('ENOENT', path))
    if (found.node === 'alias') return Promise.reject(error('EACCES', path))
    return Promise.resolve(info(found.node, true))
  }
  return {
    lstats,
    release() {
      released = true
      for (const done of waiting.splice(0)) done()
    },
    lstat(path) {
      lstats.push(path)
      if (hung(path)) return held(() => lstatOf(path))
      if (options.hang?.some((directory) => under(path, directory))) return held(() => Promise.reject(error('ENOENT', path)))
      const failure = Object.entries(options.fail ?? {}).find(([where]) => under(path, where) || key(path) === key(where))
      if (failure !== undefined) return Promise.reject(error(failure[1], path))
      return lstatOf(path)
    },
    realpath(path) {
      const answer = (): Promise<string> => {
        let resolved = win32.normalize(path)
        for (const [from, to] of Object.entries(options.links ?? {})) {
          if (key(resolved) === key(from) || key(resolved).startsWith(`${key(from)}\\`)) resolved = win32.join(to, resolved.slice(from.length))
        }
        const found = known.get(key(resolved))
        return found === undefined ? Promise.reject(error('ENOENT', path)) : Promise.resolve(found.path)
      }
      return hung(path) ? held(answer) : answer()
    },
    stat: (path) => (hung(path) ? held(() => statOf(path)) : statOf(path)),
  }
}

function direct(file: string, args: readonly string[] = [], cwd = '.'): CommandSpec {
  return { mode: 'direct', file, args, script: '', shellPath: null, projectRoot: PROJECT, cwd }
}

function shell(script: string, shellPath: string | null = CMD): CommandSpec {
  return { mode: 'shell', file: '', args: [], script, shellPath, projectRoot: PROJECT, cwd: '.' }
}

function resolverFor(fs: WindowsResolverFs, extra: { directoryTimeoutMs?: number; log?: PlatformLog } = {}) {
  return createWindowsCommandResolver({ cmdExe: CMD, fs, ...extra })
}

function planOf(result: ResolveResult): SpawnPlan {
  if (!result.ok) throw new Error(`refused: ${result.diagnostics.join(' | ')}`)
  return result.plan
}

function refusal(result: ResolveResult): string {
  if (result.ok) throw new Error(`planned: ${JSON.stringify(result.plan)}`)
  return result.diagnostics.join(' | ')
}

describe('Windows command resolver (design D2)', () => {
  // A program found through PATHEXT is planned with the extension as PATHEXT spells it, as cmd.exe
  // starts it; Windows file names are compared regardless of case.
  describe('bare names', () => {
    it('searches the Path directories in order, and in each the PATHEXT extensions in order', async () => {
      const fs = fakeFs({ 'C:\\a\\tool.bat': 'file', 'C:\\a\\tool.exe': 'file', 'C:\\b\\tool.com': 'file' })
      const resolver = resolverFor(fs)
      const env: Env = { Path: 'C:\\a;C:\\b' }
      // The default PATHEXT is .COM;.EXE;.BAT;.CMD: C:\a has no tool.com, so tool.exe wins over tool.bat and C:\b.
      expect(planOf(await resolver.resolve(direct('tool', ['--x']), env))).toEqual({ file: 'C:\\a\\tool.EXE', args: ['--x'], cwd: PROJECT, env })
      // A PATHEXT of its own, looked up regardless of the case of its name.
      expect(planOf(await resolver.resolve(direct('tool'), { PATH: 'C:\\a;C:\\b', pathext: '.BAT;.EXE' })).commandLine).toBe(batchCommandLine(CMD, 'C:\\a\\tool.BAT', []))
      // Nothing in C:\a with .COM only: C:\b is next.
      expect(planOf(await resolver.resolve(direct('tool'), { Path: 'C:\\a;C:\\b', PATHEXT: '.COM' })).file).toBe('C:\\b\\tool.COM')
    })

    it('tries a name that has an extension as given first, then with each PATHEXT extension', async () => {
      const fs = fakeFs({ 'C:\\bin\\node.exe': 'file', 'C:\\bin\\app.v2.exe': 'file' })
      const resolver = resolverFor(fs)
      expect(planOf(await resolver.resolve(direct('node.exe'), { Path: 'C:\\bin' })).file).toBe('C:\\bin\\node.exe')
      expect(fs.lstats).toEqual(['C:\\bin\\node.exe'])
      expect(planOf(await resolver.resolve(direct('app.v2'), { Path: 'C:\\bin' })).file).toBe('C:\\bin\\app.v2.EXE')
    })

    it('ignores an extensionless npm beside npm.cmd, as cmd.exe does (the layout of a Node.js install)', async () => {
      const fs = fakeFs({ 'C:\\Program Files\\nodejs\\npm': 'file', 'C:\\Program Files\\nodejs\\npm.cmd': 'file', 'C:\\Program Files\\nodejs\\npm.ps1': 'file' })
      const plan = planOf(await resolverFor(fs).resolve(direct('npm', ['run', 'dev']), { Path: 'C:\\Program Files\\nodejs' }))
      expect(plan).toMatchObject({ file: CMD, args: [], commandLine: batchCommandLine(CMD, 'C:\\Program Files\\nodejs\\npm.CMD', ['run', 'dev']) })
      expect(fs.lstats).not.toContain('C:\\Program Files\\nodejs\\npm')
    })

    it('[spec:project-registry/unsupported-program-type-refused] refuses a first match of another type, naming the file and the accepted types, and does not skip it', async () => {
      // Windows' own default PATHEXT also lists .VBS, .JS and others; the first match decides, even when a .cmd follows.
      const fs = fakeFs({ 'C:\\a\\npm.js': 'file', 'C:\\a\\npm.cmd': 'file', 'C:\\b\\npm.cmd': 'file', 'C:\\a\\setup.vbs': 'file', 'C:\\a\\build.ps1': 'file' })
      const resolver = resolverFor(fs)
      const message = refusal(await resolver.resolve(direct('npm'), { Path: 'C:\\a;C:\\b', PATHEXT: '.JS;.CMD' }))
      expect(message).toBe('C:\\a\\npm.JS is not a program Veydr can start on Windows: only .exe, .com, .bat and .cmd files are started')
      expect(refusal(await resolver.resolve(direct('setup'), { Path: 'C:\\a', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS' }))).toContain('C:\\a\\setup.VBS is not a program')
      // Named with its extension, or by path.
      expect(refusal(await resolver.resolve(direct('build.ps1'), { Path: 'C:\\a' }))).toContain('C:\\a\\build.ps1 is not a program')
      expect(refusal(await resolver.resolve(direct('C:\\a\\build.ps1'), {}))).toContain('only .exe, .com, .bat and .cmd')
    })

    it('[spec:project-registry/working-directory-not-searched] never looks up a bare name in the working directory', async () => {
      const fs = fakeFs({ [`${PROJECT}\\tool.exe`]: 'file', [`${PROJECT}\\npm.cmd`]: 'file', 'C:\\bin\\npm.cmd': 'file', 'C:\\bin\\other.exe': 'file' })
      const resolver = resolverFor(fs)
      expect(refusal(await resolver.resolve(direct('tool'), { Path: 'C:\\bin' }))).toBe('Executable not found: tool (searched PATH with the extensions .COM;.EXE;.BAT;.CMD)')
      // A decoy npm.cmd in the working directory is not the one planned.
      expect(planOf(await resolver.resolve(direct('npm'), { Path: 'C:\\bin' })).commandLine).toBe(batchCommandLine(CMD, 'C:\\bin\\npm.CMD', []))
      // `.` and other relative Path entries would mean the working directory: skipped.
      expect(refusal(await resolver.resolve(direct('tool'), { Path: '.;.\\;shop;C:\\bin' }))).toContain('Executable not found: tool')
      expect(fs.lstats.filter((path) => path.toLowerCase().startsWith(PROJECT.toLowerCase()))).toEqual([])
    })

    it('reads Path as cmd.exe does: quotes removed, a ; between them kept, and empty, relative, drive-relative, root-relative and device entries skipped', () => {
      expect(pathDirectories('"C:\\Program Files\\x";;bin;.\\bin;C:rel;\\root;\\\\?\\C:\\dev;\\\\.\\pipe;"";C:\\y\\;\\\\server\\share\\bin;C:\\a"b"c')).toEqual([
        'C:\\Program Files\\x',
        'C:\\y\\',
        '\\\\server\\share\\bin',
        'C:\\abc',
      ])
      expect(pathDirectories('"C:\\a;b";C:\\c')).toEqual(['C:\\a;b', 'C:\\c'])
      // An unbalanced quote makes the rest of Path one entry, as in cmd.exe: later directories are lost.
      expect(pathDirectories('C:\\x;"C:\\a;C:\\b')).toEqual(['C:\\x', 'C:\\a;C:\\b'])
      expect(pathDirectories(undefined)).toEqual([])
    })

    it('reads PATHEXT entries in order, ignoring malformed ones, and defaults when none is left', () => {
      expect(pathExtensions(' .CMD ; .exe;EXE;;.a.b;.x y;.\\x;.PS1')).toEqual(['.CMD', '.exe', '.PS1'])
      expect(pathExtensions('')).toEqual(DEFAULT_PATHEXT.split(';'))
      expect(pathExtensions(';;')).toEqual(DEFAULT_PATHEXT.split(';'))
      expect(pathExtensions(undefined)).toEqual(['.COM', '.EXE', '.BAT', '.CMD'])
    })

    it('finds quoted Path entries, and reports a missing program with the extensions tried', async () => {
      const fs = fakeFs({ 'C:\\Program Files\\Git\\cmd\\git.exe': 'file' })
      const resolver = resolverFor(fs)
      expect(planOf(await resolver.resolve(direct('git'), { Path: '"C:\\Program Files\\Git\\cmd"' })).file).toBe('C:\\Program Files\\Git\\cmd\\git.EXE')
      expect(refusal(await resolver.resolve(direct('git'), {}))).toBe('Executable not found: git (searched PATH with the extensions .COM;.EXE;.BAT;.CMD)')
    })

    it('skips a directory named like a program', async () => {
      const fs = fakeFs({ 'C:\\a\\npm.cmd': 'dir', 'C:\\b\\npm.cmd': 'file' })
      expect(planOf(await resolverFor(fs).resolve(direct('npm'), { Path: 'C:\\a;C:\\b' })).commandLine).toBe(batchCommandLine(CMD, 'C:\\b\\npm.CMD', []))
    })

    it('skips a Path directory that does not answer in time or cannot be read, names it, and logs it without values', async () => {
      const fs = fakeFs({ 'C:\\fast\\tool.exe': 'file' }, { hang: ['\\\\offline\\share'], fail: { 'C:\\locked': 'EACCES' } })
      const log = { record: vi.fn() }
      const resolver = resolverFor(fs, { directoryTimeoutMs: 20, log })
      expect(planOf(await resolver.resolve(direct('tool'), { Path: '\\\\offline\\share;C:\\locked;C:\\fast' })).file).toBe('C:\\fast\\tool.EXE')
      expect(log.record.mock.calls).toEqual([
        ['warn', 'command.path-directory-skipped', { directory: '\\\\offline\\share', reason: 'timeout' }],
        ['warn', 'command.path-directory-skipped', { directory: 'C:\\locked', reason: 'EACCES' }],
      ])
      // A resolver of its own: this one still waits for the share's first check (see the next tests).
      expect(refusal(await resolverFor(fs, { directoryTimeoutMs: 20 }).resolve(direct('missing'), { Path: '\\\\offline\\share;C:\\locked' }))).toBe(
        'Executable not found: missing (searched PATH with the extensions .COM;.EXE;.BAT;.CMD) | These PATH directories were skipped: \\\\offline\\share (no answer within 20 ms); C:\\locked (EACCES)',
      )
    })

    it('limits each directory to 2 s by default', async () => {
      vi.useFakeTimers()
      try {
        const fs = fakeFs({ 'C:\\fast\\tool.exe': 'file' }, { hang: ['\\\\offline\\share'] })
        const pending = resolverFor(fs).resolve(direct('tool'), { Path: '\\\\offline\\share;C:\\fast' })
        let settled = false
        void pending.then(() => (settled = true))
        await vi.advanceTimersByTimeAsync(1999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(planOf(await pending).file).toBe('C:\\fast\\tool.EXE')
      } finally {
        vi.useRealTimers()
      }
    })

    it('starts no further check in a directory once its time is up, even when the hung check answers later', async () => {
      const fs = fakeFs({ 'C:\\fast\\tool.exe': 'file' }, { hang: ['\\\\offline\\share'] })
      const resolver = resolverFor(fs, { directoryTimeoutMs: 20 })
      expect(planOf(await resolver.resolve(direct('tool'), { Path: '\\\\offline\\share;C:\\fast' })).file).toBe('C:\\fast\\tool.EXE')
      const inShare = (): string[] => fs.lstats.filter((path) => path.startsWith('\\\\offline\\share\\'))
      expect(inShare()).toEqual(['\\\\offline\\share\\tool.COM'])
      // Windows gives up on the share: the abandoned search must not go on to tool.EXE, .BAT and .CMD.
      fs.release()
      await new Promise((done) => setTimeout(done, 10))
      expect(inShare()).toEqual(['\\\\offline\\share\\tool.COM'])
    })

    it('starts no check of a directory, in a later search, while an earlier check of it is still waiting', async () => {
      const fs = fakeFs({ 'C:\\fast\\tool.exe': 'file', 'C:\\fast\\other.exe': 'file' }, { hang: ['\\\\offline\\share'] })
      const log = { record: vi.fn() }
      const resolver = resolverFor(fs, { directoryTimeoutMs: 20, log })
      const env = { Path: '\\\\offline\\share;C:\\fast' }
      expect(planOf(await resolver.resolve(direct('tool'), env)).file).toBe('C:\\fast\\tool.EXE')
      // Counted as unanswered at once: no new check of the share (below), so no time is waited out again.
      expect(planOf(await resolver.resolve(direct('other'), env)).file).toBe('C:\\fast\\other.EXE')
      const inShare = (): string[] => fs.lstats.filter((path) => path.startsWith('\\\\offline\\'))
      expect(inShare()).toEqual(['\\\\offline\\share\\tool.COM'])
      expect(log.record).toHaveBeenLastCalledWith('warn', 'command.path-directory-skipped', { directory: '\\\\offline\\share', reason: 'still-waiting' })
      // Once Windows gives up on the share, it is checked again.
      fs.release()
      await new Promise((done) => setTimeout(done, 10))
      await resolver.resolve(direct('other'), env)
      expect(inShare()).toEqual(['tool.COM', 'other.COM', 'other.EXE', 'other.BAT', 'other.CMD'].map((name) => `\\\\offline\\share\\${name}`))
    })

    it('counts still-waiting directories toward the stop, and refuses a still-waiting program path at once', async () => {
      const fs = fakeFs(
        { 'C:\\fast\\tool.exe': 'file', '\\\\offline\\share\\tool.exe': 'file' },
        { hang: ['\\\\a\\s', '\\\\b\\s'], hangPaths: ['\\\\offline\\share\\tool.exe'] },
      )
      const resolver = resolverFor(fs, { directoryTimeoutMs: 20 })
      const env = { Path: '\\\\a\\s;\\\\b\\s;C:\\fast' }
      await resolver.resolve(direct('tool'), env)
      const lstats = fs.lstats.length
      expect(refusal(await resolver.resolve(direct('tool'), env))).toBe(
        'Executable not found: tool (the search of PATH stopped after 2 directories did not answer within 20 ms) | These PATH directories were skipped: \\\\a\\s (an earlier check of it has not answered yet); \\\\b\\s (an earlier check of it has not answered yet)',
      )
      expect(fs.lstats.length).toBe(lstats)
      expect(refusal(await resolver.resolve(direct('\\\\offline\\share\\tool.exe'), {}))).toContain('(no answer within 20 ms)')
      expect(refusal(await resolver.resolve(direct('\\\\OFFLINE\\share\\tool.exe'), {}))).toBe('Executable cannot be read: \\\\OFFLINE\\share\\tool.exe (an earlier check of it has not answered yet)')
      fs.release()
    })

    it(`stops the search after ${MAX_UNANSWERED_DIRECTORIES} unanswered directories, so hung checks cannot use up the filesystem threads`, async () => {
      const fs = fakeFs({ 'C:\\fast\\tool.exe': 'file' }, { hang: ['\\\\a\\s', '\\\\b\\s', '\\\\c\\s'] })
      const log = { record: vi.fn() }
      const message = refusal(await resolverFor(fs, { directoryTimeoutMs: 20, log }).resolve(direct('tool'), { Path: '\\\\a\\s;C:\\locked;\\\\b\\s;\\\\c\\s;C:\\fast' }))
      expect(message).toBe(
        'Executable not found: tool (the search of PATH stopped after 2 directories did not answer within 20 ms) | These PATH directories were skipped: \\\\a\\s (no answer within 20 ms); \\\\b\\s (no answer within 20 ms)',
      )
      expect(fs.lstats.some((path) => path.startsWith('\\\\c\\') || path.startsWith('C:\\fast'))).toBe(false)
      expect(log.record).toHaveBeenCalledTimes(2)
      fs.release()
    })

    it('logs a PATHEXT with no usable extension and uses the default', async () => {
      const log = { record: vi.fn() }
      const resolver = resolverFor(fakeFs({ 'C:\\bin\\tool.exe': 'file' }), { log })
      expect(planOf(await resolver.resolve(direct('tool'), { Path: 'C:\\bin', PATHEXT: 'EXE;CMD' })).file).toBe('C:\\bin\\tool.EXE')
      expect(log.record).toHaveBeenCalledWith('warn', 'command.pathext-unusable', { fallback: DEFAULT_PATHEXT })
      log.record.mockClear()
      await resolver.resolve(direct('tool'), { Path: 'C:\\bin', PATHEXT: '' })
      expect(log.record).not.toHaveBeenCalled()
    })

    it('refuses a name with an extension that matches a file of another type first, as cmd.exe would run it', async () => {
      // `python3.11` has the extension `.11`, so it is tried as given before `python3.11.exe`.
      const fs = fakeFs({ 'C:\\py\\python3.11': 'file', 'C:\\py\\python3.11.exe': 'file' })
      expect(refusal(await resolverFor(fs).resolve(direct('python3.11'), { Path: 'C:\\py' }))).toBe(
        'C:\\py\\python3.11 is not a program Veydr can start on Windows: only .exe, .com, .bat and .cmd files are started',
      )
    })

    it('follows links: one to a directory is no match, a dangling one is missing, and an App Execution Alias is found', async () => {
      const fs = fakeFs({
        'C:\\a\\tool.exe': 'link-dir',
        'C:\\b\\tool.exe': 'link-dangling',
        'C:\\c\\tool.exe': 'link-file',
        'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe': 'alias',
      })
      const resolver = resolverFor(fs)
      expect(planOf(await resolver.resolve(direct('tool.exe'), { Path: 'C:\\a;C:\\b;C:\\c' })).file).toBe('C:\\c\\tool.exe')
      expect(refusal(await resolver.resolve(direct('C:\\a\\tool.exe'), {}))).toBe('Executable is a directory, not a file: C:\\a\\tool.exe')
      expect(refusal(await resolver.resolve(direct('C:\\b\\tool.exe'), {}))).toBe('Executable not found: C:\\b\\tool.exe')
      const aliases = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps'
      expect(planOf(await resolver.resolve(direct('winget'), { Path: aliases })).file).toBe(`${aliases}\\winget.EXE`)
    })

    it('refuses names Windows would read as another file, a data stream or a pattern', async () => {
      const resolver = resolverFor(fakeFs({ 'C:\\bin\\tool.exe': 'file' }))
      const env = { Path: 'C:\\bin' }
      for (const name of ['tool.exe.', 'tool ', 'tool:stream', 'to*l', 'to?l', 'a|b', 'a<b', 'a"b', 'tab\there', 'nul', 'AUX', 'con.exe', 'COM1', 'lpt9.cmd', 'Nul .cmd', 'conin$']) {
        expect(refusal(await resolver.resolve(direct(name), env))).toMatch(/^The program name ".*" cannot be used: /s)
      }
      expect(refusal(await resolver.resolve(direct(''), env))).toBe('No program is given')
      expect(refusal(await resolver.resolve(direct('to\0ol'), env))).toBe('The program contains a NUL character')
    })
  })

  describe('paths', () => {
    it('[spec:project-registry/drive-relative-program-path-refused] refuses C:tool.exe and \\tools\\tool.exe, asking for a full or working-directory-relative path', async () => {
      const fs = fakeFs({ 'C:\\tool.exe': 'file', 'C:\\tools\\tool.exe': 'file' })
      const resolver = resolverFor(fs)
      for (const file of ['C:tool.exe', 'c:tools\\tool.exe', '\\tools\\tool.exe', '/tools/tool.exe']) {
        expect(refusal(await resolver.resolve(direct(file), {}))).toBe(
          `The program "${file}" depends on the current drive or its current directory: give a full path (C:\\…) or a path relative to the working directory`,
        )
      }
      expect(fs.lstats).toEqual([])
    })

    it('uses drive and UNC paths as given, and resolves other paths against the working directory', async () => {
      const fs = fakeFs({
        'D:\\tools\\tool.exe': 'file',
        '\\\\server\\share\\bin\\tool.exe': 'file',
        [`${PROJECT}\\api\\node_modules\\.bin\\vite.cmd`]: 'file',
        [`${PROJECT}\\scripts\\run.exe`]: 'file',
      })
      const resolver = resolverFor(fs)
      expect(planOf(await resolver.resolve(direct('D:\\tools\\tool.exe', ['a b']), {}))).toMatchObject({ file: 'D:\\tools\\tool.exe', args: ['a b'] })
      expect(planOf(await resolver.resolve(direct('D:/tools/tool.exe'), {})).file).toBe('D:\\tools\\tool.exe')
      expect(planOf(await resolver.resolve(direct('\\\\server\\share\\bin\\tool.exe'), {})).file).toBe('\\\\server\\share\\bin\\tool.exe')
      const vite = planOf(await resolver.resolve(direct('node_modules\\.bin\\vite.cmd', ['--port', '5173'], 'api'), {}))
      expect(vite).toMatchObject({ file: CMD, cwd: `${PROJECT}\\api`, commandLine: batchCommandLine(CMD, `${PROJECT}\\api\\node_modules\\.bin\\vite.cmd`, ['--port', '5173']) })
      expect(planOf(await resolver.resolve(direct('..\\scripts\\run.exe', [], 'api'), {})).file).toBe(`${PROJECT}\\scripts\\run.exe`)
      expect(planOf(await resolver.resolve(direct('./scripts/run.exe'), {})).file).toBe(`${PROJECT}\\scripts\\run.exe`)
    })

    it('names a missing program, a directory, and refuses device paths and bad segments', async () => {
      const fs = fakeFs({ 'C:\\tools\\dir.exe': 'dir', 'C:\\tools\\tool.exe': 'file' })
      const resolver = resolverFor(fs)
      expect(refusal(await resolver.resolve(direct('bin\\missing.exe'), {}))).toBe('Executable not found: bin\\missing.exe')
      expect(refusal(await resolver.resolve(direct('C:\\tools\\dir.exe'), {}))).toBe('Executable is a directory, not a file: C:\\tools\\dir.exe')
      expect(refusal(await resolver.resolve(direct('\\\\?\\C:\\tools\\tool.exe'), {}))).toContain('not a \\\\.\\ or \\\\?\\ path')
      expect(refusal(await resolver.resolve(direct('\\\\.\\C:\\tools\\tool.exe'), {}))).toContain('not a \\\\.\\ or \\\\?\\ path')
      expect(refusal(await resolver.resolve(direct('C:\\tools\\tool.exe:stream'), {}))).toContain('cannot be used')
      expect(refusal(await resolver.resolve(direct('C:\\tools\\tool.exe.'), {}))).toContain('ends in a dot or a space')
      expect(refusal(await resolver.resolve(direct('C:\\tools \\tool.exe'), {}))).toContain('ends in a dot or a space')
      expect(refusal(await resolver.resolve(direct('C:\\tools\\nul.cmd'), {}))).toContain('is a Windows device name')
      expect(refusal(await resolver.resolve(direct('bin\\aux\\tool.exe'), {}))).toContain('is a Windows device name')
      // Only the segments as given are checked, and `.` and `..` on the way are fine.
      expect(refusal(await resolver.resolve(direct('bin.\\tool.exe'), {}))).toBe('The program path "bin.\\tool.exe" cannot be used: it ends in a dot or a space, which Windows drops from file names')
      expect(refusal(await resolver.resolve(direct('C:\\tools\\..'), {}))).toContain('it names no file')
    })

    it('names a program path that cannot be read, or whose parent is a file', async () => {
      const fs = fakeFs({ 'C:\\tools\\tool.exe': 'file' }, { fail: { 'C:\\locked\\tool.exe': 'EACCES', 'C:\\tools\\tool.exe\\x.exe': 'ENOTDIR' } })
      const resolver = resolverFor(fs)
      expect(refusal(await resolver.resolve(direct('C:\\locked\\tool.exe'), {}))).toBe('Executable cannot be read: C:\\locked\\tool.exe (EACCES)')
      expect(refusal(await resolver.resolve(direct('C:\\tools\\tool.exe\\x.exe'), {}))).toBe('Executable not found: C:\\tools\\tool.exe\\x.exe')
    })

    it('limits every other check in time: a program or shell path, and the project folder on an unreachable share', async () => {
      const fs = fakeFs(
        { '\\\\one\\share\\tool.exe': 'file', '\\\\two\\share\\cmd.exe': 'file', '\\\\three\\proj': 'dir' },
        { hangPaths: ['\\\\one\\share\\tool.exe', '\\\\two\\share\\cmd.exe', '\\\\three\\proj'] },
      )
      const resolver = resolverFor(fs, { directoryTimeoutMs: 20 })
      expect(refusal(await resolver.resolve(direct('\\\\one\\share\\tool.exe'), {}))).toBe('Executable cannot be read: \\\\one\\share\\tool.exe (no answer within 20 ms)')
      expect(refusal(await resolver.resolve(shell('echo hi', '\\\\two\\share\\cmd.exe'), {}))).toBe('Shell cannot be read: \\\\two\\share\\cmd.exe (no answer within 20 ms)')
      expect(refusal(await resolver.resolve({ ...direct('tool'), projectRoot: '\\\\three\\proj' }, {}))).toBe('The project folder cannot be read: \\\\three\\proj (ETIMEDOUT)')
      // A server that did not answer is not asked again while that check waits, for any path on it.
      const calls = fs.lstats.length
      expect(refusal(await resolver.resolve(shell('echo hi', '\\\\ONE\\other\\cmd.exe'), {}))).toBe('Shell cannot be read: \\\\ONE\\other\\cmd.exe (an earlier check of it has not answered yet)')
      expect(refusal(await resolver.resolve(direct('tool'), { Path: '\\\\one\\bin;\\\\two\\bin' }))).toContain('\\\\one\\bin (an earlier check of it has not answered yet); \\\\two\\bin (an earlier check of it has not answered yet)')
      expect(fs.lstats.length).toBe(calls)
      fs.release()
    })

    it('remembers a hung check by UNC server, or by the path without letter case or a trailing separator', () => {
      expect(checkKey('\\\\Server\\Share\\bin\\tool.exe')).toBe('\\\\server')
      expect(checkKey('//server/share')).toBe('\\\\server')
      expect(checkKey('C:\\Tools\\')).toBe('c:\\tools')
      expect(checkKey('C:\\tools')).toBe('c:\\tools')
      expect(checkKey('C:\\')).toBe('c:\\')
      expect(checkKey('c:/a/../b//')).toBe('c:\\b')
    })

    it('plans a batch file through cmd.exe with no separate arguments, and refuses arguments cmd.exe cannot carry', async () => {
      const fs = fakeFs({ 'C:\\tools\\build.bat': 'file', 'C:\\tools\\BUILD2.CMD': 'file' })
      const resolver = resolverFor(fs)
      const env = { Path: 'C:\\tools' }
      expect(planOf(await resolver.resolve(direct('build', ['release', 'C:\\out\\']), env))).toEqual({
        file: CMD,
        args: [],
        cwd: PROJECT,
        env,
        commandLine: `"${CMD}" /d /v:off /s /c ""C:\\tools\\build.BAT" release C:\\out\\"`,
      })
      expect(planOf(await resolver.resolve(direct('C:\\tools\\BUILD2.CMD', ['a&b']), {})).commandLine).toBe(batchCommandLine(CMD, 'C:\\tools\\BUILD2.CMD', ['a&b']))
      expect(refusal(await resolver.resolve(direct('build', ['one\ntwo']), env))).toBe('Argument 1 contains a line break, which cmd.exe cannot pass to a batch file: it runs one line')
      expect(refusal(await resolver.resolve(direct('build', ['x'.repeat(8000)]), env))).toContain('8191')
    })

    it('refuses arguments no command line can carry for an ordinary program before planning', async () => {
      const resolver = resolverFor(fakeFs({ 'C:\\tools\\tool.exe': 'file' }))
      expect(refusal(await resolver.resolve(direct('C:\\tools\\tool.exe', ['a\0b']), {}))).toContain('NUL')
      expect(refusal(await resolver.resolve(direct('C:\\tools\\tool.exe', ['x'.repeat(33_000)]), {}))).toContain('32766')
      expect(planOf(await resolver.resolve(direct('C:\\tools\\tool.exe', ['x'.repeat(32_000)]), {})).args).toHaveLength(1)
    })
  })

  describe('shell mode', () => {
    it('runs the script verbatim through the configured cmd.exe', async () => {
      const resolver = resolverFor(fakeFs({ 'D:\\Win\\System32\\CMD.EXE': 'file' }))
      const script = 'echo %USERNAME% && npm run build'
      expect(planOf(await resolver.resolve(shell(script), {}))).toEqual({ file: CMD, args: [], cwd: PROJECT, env: {}, commandLine: shellCommandLine(CMD, script) })
      expect(planOf(await resolver.resolve(shell(script, 'D:\\Win\\System32\\CMD.EXE'), {})).file).toBe('D:\\Win\\System32\\CMD.EXE')
    })

    it('[spec:project-registry/other-shell-refused-on-windows] refuses powershell.exe and bash.exe in shell mode, naming cmd.exe', async () => {
      const resolver = resolverFor(fakeFs({ 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': 'file', 'C:\\Program Files\\Git\\bin\\bash.exe': 'file' }))
      for (const shellPath of [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'cmd.exe',
        'C:cmd.exe',
        '\\Windows\\System32\\cmd.exe',
        'C:\\Windows\\System32\\cmd.exe\\..\\bash.exe',
        'C:\\Windows\\System32\\cmd',
      ]) {
        expect(refusal(await resolver.resolve(shell('echo hi', shellPath), {}))).toBe(
          `On Windows, shell mode supports cmd.exe only, given by its full path (such as ${CMD}): ${shellPath}`,
        )
      }
      expect(refusal(await resolver.resolve(shell('echo hi', null), {}))).toBe(`On Windows, shell mode supports cmd.exe only, given by its full path (such as ${CMD}): no shell is set`)
    })

    it('[spec:project-registry/multi-line-script-refused-on-windows] refuses a script with a line break, a blank script, and a missing cmd.exe', async () => {
      const resolver = resolverFor(fakeFs({}))
      expect(refusal(await resolver.resolve(shell('npm ci\r\nnpm test'), {}))).toBe('The script contains a line break, but cmd.exe runs one line: join the commands with && or &')
      expect(refusal(await resolver.resolve(shell('   '), {}))).toBe('The script is empty')
      expect(refusal(await resolver.resolve(shell('echo hi', 'E:\\nowhere\\cmd.exe'), {}))).toBe('Shell not found: E:\\nowhere\\cmd.exe')
    })

    it('checks the segments of the shell path as it does a program path', async () => {
      const resolver = resolverFor(fakeFs({}))
      for (const [shellPath, reason] of [
        ['C:\\Windows\\System32\\cmd.exe.', 'ends in a dot or a space'],
        ['C:\\dir.\\cmd.exe', 'ends in a dot or a space'],
        ['C:\\dir \\cmd.exe', 'ends in a dot or a space'],
        ['C:\\nul\\cmd.exe', 'is a Windows device name'],
        ['C:\\a:b\\cmd.exe', 'a character Windows file names cannot hold'],
      ] as const) {
        expect(refusal(await resolver.resolve(shell('echo hi', shellPath), {}))).toContain(`The shell path "${shellPath}" cannot be used: `)
        expect(refusal(await resolver.resolve(shell('echo hi', shellPath), {}))).toContain(reason)
      }
    })
  })

  describe('working directory', () => {
    it('uses the shared project-folder and working-directory checks with Windows paths, regardless of case', async () => {
      const fs = fakeFs(
        { [`${PROJECT}\\api`]: 'dir', 'C:\\elsewhere\\data': 'dir', 'C:\\bin\\tool.exe': 'file' },
        { links: { [`${PROJECT}\\escape`]: 'C:\\elsewhere', [`${PROJECT}\\Short~1`]: `${PROJECT.toUpperCase()}\\API` } },
      )
      const resolver = resolverFor(fs)
      const env = { Path: 'C:\\bin' }
      expect(planOf(await resolver.resolve(direct('tool', [], 'API'), env)).cwd).toBe(`${PROJECT}\\api`)
      // A junction whose target differs only in letter case is still inside.
      expect(planOf(await resolver.resolve(direct('tool', [], 'Short~1'), env)).cwd).toBe(`${PROJECT}\\api`)
      expect(refusal(await resolver.resolve(direct('tool', [], '..'), env))).toBe(`The working directory ".." is outside the project folder ${PROJECT}`)
      expect(refusal(await resolver.resolve(direct('tool', [], 'D:\\'), env))).toBe(`The working directory "D:\\" is outside the project folder ${PROJECT}`)
      expect(refusal(await resolver.resolve(direct('tool', [], 'escape\\data'), env))).toBe(
        `The working directory "escape\\data" is outside the project folder ${PROJECT} (it resolves to C:\\elsewhere\\data)`,
      )
      expect(refusal(await resolver.resolve(direct('tool', [], 'missing'), env))).toBe(`Working directory does not exist: ${PROJECT}\\missing`)
      expect(refusal(await resolver.resolve({ ...direct('tool'), projectRoot: 'C:\\gone' }, env))).toBe('The project folder is missing: C:\\gone')
    })
  })

  it('uses cmd.exe of SystemRoot, or C:\\Windows when SystemRoot is unset or not a full drive path', () => {
    expect(systemCmdExe('C:\\Windows')).toBe(CMD)
    expect(systemCmdExe('D:\\WINNT\\')).toBe('D:\\WINNT\\System32\\cmd.exe')
    for (const unusable of [undefined, '', 'Windows', 'C:', 'C:Windows', '\\Windows', '%SystemDrive%\\Windows', 'C:\\Win"dows']) {
      expect(systemCmdExe(unusable)).toBe(CMD)
    }
  })
})
