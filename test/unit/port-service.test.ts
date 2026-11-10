import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { PortSnapshot, ProcessIdentity } from '../../src/main/platform/types'
import { createPortService, type PortServiceDeps } from '../../src/main/ports/service'
import { portSnapshotSchema } from '../../src/shared/api'

// Tasks 8.2 and 8.3: attribution of listening ports to commands, and the read-only boundary of
// port inspection.

const API = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const WEB = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'
const id = (pid: number, starttime: number): ProcessIdentity => ({ pid, token: `boot:${starttime}` })

describe('port service', () => {
  it('[spec:port-inspection/dev-server-port-shown] attributes a port to the command whose process holds it', async () => {
    const service = createPortService({
      inspector: {
        list: () =>
          Promise.resolve({
            takenAt: 1_000,
            ports: [{ family: 'ipv4', address: '127.0.0.1', port: 5173, owner: { kind: 'known', processes: [{ identity: id(42, 7), name: 'node' }] } }],
          }),
      },
      attribution: () => Promise.resolve([{ commandId: API, processes: [id(40, 5), id(42, 7)] }]),
    })
    const snapshot = await service.list()
    expect(snapshot).toEqual({ refreshedAt: 1_000, ports: [{ family: 'ipv4', address: '127.0.0.1', port: 5173, owner: { kind: 'known', pid: 42, name: 'node', commandId: API } }] })
    expect(portSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  it('matches processes by identity: a reused PID does not make a port managed', async () => {
    const service = createPortService({
      inspector: {
        list: () =>
          Promise.resolve({ takenAt: 1, ports: [{ family: 'ipv6', address: '::', port: 8080, owner: { kind: 'known', processes: [{ identity: id(42, 900), name: 'python3' }] } }] }),
      },
      attribution: () => Promise.resolve([{ commandId: API, processes: [id(42, 7)] }]),
    })
    expect((await service.list()).ports[0]?.owner).toEqual({ kind: 'known', pid: 42, name: 'python3', commandId: null })
  })

  it('shows the holder of a shared socket that belongs to a command, else the oldest holder; passes restricted and unknown owners on', async () => {
    const inherited: PortSnapshot = {
      takenAt: 5,
      ports: [
        // The oldest holder (an unmanaged parent) passed the socket to a command's process.
        { family: 'ipv4', address: '0.0.0.0', port: 3000, owner: { kind: 'known', processes: [{ identity: id(10, 1), name: 'systemd' }, { identity: id(50, 9), name: 'node' }] } },
        { family: 'ipv4', address: '0.0.0.0', port: 3001, owner: { kind: 'known', processes: [{ identity: id(60, 2), name: 'nginx' }, { identity: id(61, 3), name: 'nginx' }] } },
        { family: 'ipv4', address: '127.0.0.1', port: 631, owner: { kind: 'restricted' } },
        { family: 'ipv6', address: '::1', port: 9000, owner: { kind: 'unknown' } },
      ],
    }
    const service = createPortService({
      inspector: { list: () => Promise.resolve(inherited) },
      attribution: () => Promise.resolve([{ commandId: WEB, processes: [id(50, 9)] }]),
    })
    expect((await service.list()).ports.map((p) => p.owner)).toEqual([
      { kind: 'known', pid: 50, name: 'node', commandId: WEB },
      { kind: 'known', pid: 60, name: 'nginx', commandId: null },
      { kind: 'restricted' },
      { kind: 'unknown' },
    ])
  })

  it('reads sockets and attribution sets at the same time, and fails when the sockets cannot be read', async () => {
    const order: string[] = []
    const service = createPortService({
      inspector: {
        list: async () => {
          order.push('sockets')
          await new Promise((done) => setTimeout(done, 5))
          order.push('sockets done')
          return { takenAt: 1, ports: [] }
        },
      },
      attribution: async () => {
        order.push('attribution')
        await Promise.resolve()
        order.push('attribution done')
        return []
      },
    })
    await service.list()
    expect(order).toEqual(['sockets', 'attribution', 'attribution done', 'sockets done'])

    const failing = createPortService({ inspector: { list: () => Promise.reject(new Error('Could not read /proc/net/tcp')) }, attribution: () => Promise.resolve([]) })
    await expect(failing.list()).rejects.toThrow('Could not read /proc/net/tcp')
  })
})

/** Every source file `entry` reaches through relative imports (type-only imports included). */
function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
      const base = resolve(dirname(file), match[1] ?? '')
      const target = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) => existsSync(candidate))
      if (target === undefined) throw new Error(`${file}: cannot resolve ${match[1]}`)
      visit(target)
    }
  }
  visit(resolve(entry))
  return [...seen]
}

/**
 * `source` (C#) with its comments removed and every string and char literal emptied to `""` or `''`,
 * so that neither can hide code from a check nor end a brace-matched block early. Regular and
 * verbatim (`@"…"`, with `""` escapes) strings are handled; an interpolated string (`$"…"`), which
 * the helper's C# 5 does not have, is refused rather than parsed.
 */
function stripCSharp(source: string): string {
  let out = ''
  let i = 0
  const fail = (what: string): never => {
    throw new Error(`${what} at offset ${i}`)
  }
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      out += ' '
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) fail('unterminated comment')
      i = end + 2
      out += ' '
    } else if ((c === '$' && (next === '"' || next === '@')) || (c === '@' && next === '$')) {
      fail('interpolated string')
    } else if (c === '@' && next === '"') {
      let j = i + 2
      for (; ; j++) {
        if (j >= source.length) fail('unterminated verbatim string')
        if (source[j] === '"') {
          if (source[j + 1] !== '"') break
          j++
        }
      }
      out += '""'
      i = j + 1
    } else if (c === '"' || c === "'") {
      let j = i + 1
      for (; source[j] !== c; j += source[j] === '\\' ? 2 : 1) {
        if (j >= source.length || source[j] === '\n') fail('unterminated literal')
      }
      out += c + c
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

/** The text between the `{` at `open` and its matching `}` in comment- and literal-free `code`. */
function braceBody(code: string, open: number): string | null {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i)
  }
  return null
}

/** The body of the top-level type `name` (declared exactly once), or a reason it cannot be found. */
function typeBody(code: string, name: string): { body: string } | { error: string } {
  const declarations = [...code.matchAll(new RegExp(String.raw`((?:\b\w+\s+)*)\b(?:class|struct)\s+${name}\b([^{]*)\{`, 'g'))]
  if (declarations.length !== 1) return { error: `${name} must be declared exactly once, found ${declarations.length}` }
  const [match] = declarations
  if (match === undefined) return { error: `${name} is not declared` }
  if (/\bpartial\b/.test(match[1] ?? '')) return { error: `${name} must not be partial` }
  if ((match[2] ?? '').trim() !== '') return { error: `${name} must not inherit or constrain anything: ${(match[2] ?? '').trim()}` }
  const body = braceBody(code, (match.index ?? 0) + match[0].length - 1)
  return body === null ? { error: `${name} has no closing brace` } : { body }
}

/** The Native functions PortsCommand may call (design D6): reads only, each a plain P/Invoke declaration. */
const PORTS_NATIVE_CALLS = [
  'GetSystemTimePreciseAsFileTime',
  'GetExtendedTcpTable',
  'CreateToolhelp32Snapshot',
  'Process32FirstW',
  'Process32NextW',
  'OpenProcess',
  'GetExitCodeProcess',
  'GetProcessTimes',
  'QueryFullProcessImageName',
  'CloseHandle',
]

/** The Native constants and structure those calls need. */
const PORTS_NATIVE_VALUES = [
  'AF_INET',
  'AF_INET6',
  'TCP_TABLE_OWNER_PID_LISTENER',
  'NO_ERROR',
  'ERROR_INSUFFICIENT_BUFFER',
  'ERROR_ACCESS_DENIED',
  'ERROR_INVALID_PARAMETER',
  'ERROR_INVALID_DATA',
  'STILL_ACTIVE',
  'PROCESS_QUERY_LIMITED_INFORMATION',
  'TH32CS_SNAPPROCESS',
  'PROCESSENTRY32W',
  'InvalidHandle',
]

/** The classes of the file PortsCommand may use, with the members it may use where they are limited. */
const PORTS_ALLOWED_TYPES: Record<string, readonly string[] | null> = {
  Native: [...PORTS_NATIVE_CALLS, ...PORTS_NATIVE_VALUES],
  Json: ['Number', 'Quote'],
  VeydrHelper: ['ExitOk', 'ExitFailure'],
  HelperException: null,
}

/** Anything that starts, signals or ends a process, or reaches native code other than through Native. */
const PORTS_FORBIDDEN = [
  /\bCreateProcess\w*/,
  /\bTerminateProcess\b/,
  /\bTerminateJobObject\b/,
  /\bGenerateConsoleCtrlEvent\b/,
  /\bPROCESS_TERMINATE\b/,
  /\bProcessTerminate\b/,
  /\bSYNCHRONIZE\b/,
  // System.Diagnostics.Process (Start, Kill), and native code or reflection outside Native.
  /\bProcess\b/,
  /\bKill\b/,
  /\bDllImport\b/,
  /\bextern\b/,
  /\bunsafe\b/,
  /\bLoadLibrary\w*/,
  /\bGetProcAddress\b/,
  /\bGetDelegateForFunctionPointer\b/,
  /\bReflection\b/,
  /\bAssembly\b/,
  /\bAppDomain\b/,
  /\bActivator\b/,
  /\bInvokeMember\b/,
  /\bGetMethods?\b/,
  /\bGetFunctionPointerForDelegate\b/,
]

/** The library each allowed Native call must be imported from. */
const PORTS_NATIVE_LIBRARY: Record<string, string> = { GetExtendedTcpTable: 'iphlpapi.dll' }

/**
 * Checks the helper's C# source for design D6: the `PortsCommand` class opens other processes for
 * query only, and starts, signals or ends none of them. Returns the violations, none if it holds.
 */
function portsCommandViolations(source: string): string[] {
  let code: string
  try {
    code = stripCSharp(source)
  } catch (error) {
    return [`cannot read the source: ${(error as Error).message}`]
  }
  const violations: string[] = []
  // File-wide: no alias that renames another class, no extension method that hides one, no renamed entry point.
  for (const directive of code.match(/^\s*using\s+[^(\s][^;]*;/gm) ?? []) {
    if (!/^\s*using\s+System(?:\.\w+)*\s*;$/.test(directive)) violations.push(`using directive other than a System namespace: ${directive.trim()}`)
    else if (/\bReflection\b/.test(directive)) violations.push(`using directive for reflection: ${directive.trim()}`)
  }
  if (/\(\s*this\s+/.test(code)) violations.push('an extension method')
  if (/\bEntryPoint\b/.test(code)) violations.push('a DllImport EntryPoint')

  const ports = typeBody(code, 'PortsCommand')
  if ('error' in ports) return [...violations, ports.error]
  const { body } = ports

  for (const pattern of PORTS_FORBIDDEN) {
    if (pattern.test(body)) violations.push(`PortsCommand uses ${pattern.source}`)
  }

  // Classes: only the allowlist, and only their allowed members.
  const topLevel = new Set<string>()
  for (const match of code.matchAll(/\b(?:class|struct|interface|enum)\s+(\w+)/g)) {
    const before = code.slice(0, match.index)
    if ((before.match(/\{/g)?.length ?? 0) === (before.match(/\}/g)?.length ?? 0)) topLevel.add(match[1] ?? '')
  }
  for (const name of topLevel) {
    if (name === 'PortsCommand' || name in PORTS_ALLOWED_TYPES) continue
    if (new RegExp(String.raw`\b${name}\b`).test(body)) violations.push(`PortsCommand references the class ${name}`)
  }
  for (const [name, members] of Object.entries(PORTS_ALLOWED_TYPES)) {
    if (new RegExp(String.raw`\b(?:class|struct|interface|enum)\s+${name}\b`).test(body)) violations.push(`PortsCommand declares its own ${name}`)
    if (members === null) continue
    const uses = body.match(new RegExp(String.raw`\b${name}\b`, 'g'))?.length ?? 0
    const accesses = [...body.matchAll(new RegExp(String.raw`\b${name}\s*\.\s*(\w+)`, 'g'))]
    if (uses !== accesses.length) violations.push(`PortsCommand uses ${name} other than through its members`)
    for (const access of accesses) {
      if (!members.includes(access[1] ?? '')) violations.push(`PortsCommand uses ${name}.${access[1] ?? ''}`)
    }
  }

  // OpenProcess with exactly PROCESS_QUERY_LIMITED_INFORMATION, which must be 0x1000.
  const opens = body.match(/\bOpenProcess\b/g)?.length ?? 0
  const queryOnly = body.match(/\bNative\s*\.\s*OpenProcess\s*\(\s*Native\s*\.\s*PROCESS_QUERY_LIMITED_INFORMATION\s*,\s*false\s*,/g)?.length ?? 0
  if (opens === 0) violations.push('PortsCommand never calls OpenProcess, so the check proves nothing')
  if (opens !== queryOnly) violations.push('PortsCommand calls OpenProcess with other access than exactly Native.PROCESS_QUERY_LIMITED_INFORMATION, not inherited')

  // Native's side: the right is 0x1000, and every allowed call is a plain P/Invoke declaration.
  const native = typeBody(code, 'Native')
  if ('error' in native) return [...violations, native.error]
  if (!/\bconst\s+uint\s+(?:\w+\s*=\s*\w+\s*,\s*)*PROCESS_QUERY_LIMITED_INFORMATION\s*=\s*0x1000\s*[,;]/.test(native.body)) {
    violations.push('Native.PROCESS_QUERY_LIMITED_INFORMATION is not the constant 0x1000')
  }
  for (const call of PORTS_NATIVE_CALLS) {
    if (!new RegExp(String.raw`\bstatic\s+extern\s+\w+\s+${call}\s*\(`).test(native.body)) violations.push(`Native.${call} is not a P/Invoke declaration`)
    if (new RegExp(String.raw`\bstatic\s+(?!extern\b)\w+\s+${call}\s*\(`).test(native.body)) violations.push(`Native.${call} is also declared as a method with a body`)
    // The library, read from the raw source since literals are stripped: every declaration of the call is imported from it.
    const library = PORTS_NATIVE_LIBRARY[call] ?? 'kernel32.dll'
    const declarations = native.body.match(new RegExp(String.raw`\bstatic\s+extern\s+\w+\s+${call}\s*\(`, 'g'))?.length ?? 0
    const imported = [...source.matchAll(new RegExp(String.raw`\[DllImport\("([^"]*)"[^\]]*\]\s*public\s+static\s+extern\s+\w+\s+${call}\s*\(`, 'g'))]
    if (imported.length !== declarations || imported.some((match) => match[1] !== library)) violations.push(`Native.${call} is not imported from ${library} alone`)
  }
  return violations
}

describe('read-only port inspection', () => {
  const root = resolve(__dirname, '../..')
  const entries = ['src/main/ports/service.ts', 'src/main/platform/linux/ports.ts']

  it('[spec:port-inspection/no-actions-on-unrelated-processes] the ports service and the Linux inspector cannot signal, start, or connect to anything', () => {
    const forbiddenModules = /from 'node:(child_process|net|dgram|http|https|http2|tls|dns|cluster|worker_threads)'/
    // Signalling a process needs `kill` (process.kill, ChildProcess.kill) or a signal name.
    const signalling = /\bkill\s*\(|\bSIG[A-Z]{2,}\b/
    for (const entry of entries) {
      const files = importClosure(join(root, entry))
      expect(files.length, entry).toBeGreaterThan(1)
      for (const file of files) {
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
        const where = relative(root, file)
        expect(code, where).not.toMatch(forbiddenModules)
        expect(code, where).not.toMatch(signalling)
        expect(where, `${entry} reaches ${where}`).not.toMatch(/supervisor|process-tree|executable|survivors/)
      }
    }
  })

  describe('the helper\'s ports subcommand (task 2.3; design D6)', () => {
    const helperSource = readFileSync(join(root, 'src/main/platform/windows/helper/veydr-helper.cs'), 'utf8')

    it('opens other processes for query only, and starts, signals or ends none of them', () => {
      expect(portsCommandViolations(helperSource)).toEqual([])
      // `ports` reaches PortsCommand, and only without arguments.
      expect(helperSource).toContain('if (args.Length == 1 && args[0] == "ports") return PortsCommand.Run();')
      expect(helperSource.match(/PortsCommand\.Run\(\)/g)).toHaveLength(1)
    })

    /** A minimal helper source whose PortsCommand passes, with `{{BODY}}` where a statement may go. */
    const FIXTURE = `using System;
using System.Runtime.InteropServices;
static class VeydrHelper { public const int ExitOk = 0, ExitFailure = 1; }
sealed class HelperException : Exception { public HelperException(string message) : base(message) { } }
static class SurvivorCommands { public static int Terminate(int graceMs) { return 0; } }
static class PortsCommand
{
    public static int Run()
    {
        IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, 4);
        {{BODY}}
        Native.CloseHandle(process);
        return VeydrHelper.ExitOk;
    }
}
static class Native
{
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x100000;
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
}
`
    const withBody = (body: string, fixture = FIXTURE): string => fixture.replace('{{BODY}}', body)
    // The fixture declares only the calls it uses; the real file's other allowed calls are checked against it above.
    const fixtureViolations = (source: string): string[] => portsCommandViolations(source).filter((v) => !/is not a P\/Invoke declaration/.test(v))

    it('passes the fixture itself, so each negative case fails for its own reason', () => {
      expect(fixtureViolations(withBody(''))).toEqual([])
      expect(fixtureViolations(withBody('string text = "Native.TerminateProcess }"; char brace = \'}\'; // SurvivorCommands.Terminate(0);'))).toEqual([])
    })

    it.each([
      ['a call to another class of the file', 'SurvivorCommands.Terminate(0);', /references the class SurvivorCommands/],
      ['SYNCHRONIZE added to the access', 'IntPtr waitable = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.SYNCHRONIZE, false, 4);', /SYNCHRONIZE/],
      ['a forbidden call next to a comment', '/* only a query */ Native.TerminateProcess(process, 1); // harmless', /TerminateProcess/],
      ['a } in a string and in a char literal, then a forbidden call', 'string text = "}"; char brace = \'}\'; Native.TerminateProcess(process, 1);', /TerminateProcess/],
      ['a } in a verbatim string, then a forbidden call', 'string text = @"}"" }"; Native.TerminateProcess(process, 1);', /TerminateProcess/],
      ['an interpolated string', 'string text = $"{process}";', /interpolated string/],
      ['a Native call that is not a read', 'Native.AttachConsole(4);', /Native\.AttachConsole/],
      ['Native used other than through its members', 'Type native = typeof(Native);', /uses Native other than through its members/],
      ['another access right', 'IntPtr other = Native.OpenProcess(0x1, false, 4);', /other access than exactly/],
      ['an inherited handle', 'IntPtr other = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, true, 4);', /other access than exactly/],
      ['reflection through an assembly', 'System.Reflection.Assembly.GetExecutingAssembly();', /Assembly/],
      ['a function pointer for a delegate', 'Marshal.GetFunctionPointerForDelegate(null);', /GetFunctionPointerForDelegate/],
      ['System.Diagnostics.Process', 'System.Diagnostics.Process.GetProcessById(4).Kill();', /Process/],
      ['its own P/Invoke', '} [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code); static void X() {', /DllImport/],
      ['a class of its own named Native', '} static class Native { } static void X() {', /declares its own Native/],
    ])('fails on %s', (_what, body, reason) => {
      const violations = fixtureViolations(withBody(body))
      expect(violations.some((violation) => reason.test(violation)), violations.join('\n')).toBe(true)
    })

    it.each([
      ['a reflection namespace', (s: string) => s.replace('using System;', 'using System;\nusing System.Reflection;'), /using directive for reflection/],
      ['a call imported from another library', (s: string) => s.replace('[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle', '[DllImport("ntdll.dll", SetLastError = true)] public static extern bool CloseHandle'), /CloseHandle is not imported from kernel32\.dll alone/],
      ['a using alias for another class', (s: string) => s.replace('using System;', 'using System;\nusing Survivors = SurvivorCommands;'), /using directive/],
      ['an extension method elsewhere', (s: string) => s.replace('public static int Terminate(int graceMs)', 'public static int Terminate(this IntPtr p, int graceMs)'), /extension method/],
      ['a renamed entry point', (s: string) => s.replace('[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle', '[DllImport("kernel32.dll", EntryPoint = "TerminateProcess")] public static extern bool CloseHandle'), /EntryPoint/],
      ['a partial PortsCommand', (s: string) => s.replace('static class PortsCommand', 'static partial class PortsCommand'), /must not be partial/],
      ['a second PortsCommand', (s: string) => `${s}\nstatic class PortsCommand { }`, /declared exactly once/],
      ['another value of the query right', (s: string) => s.replace('PROCESS_QUERY_LIMITED_INFORMATION = 0x1000', 'PROCESS_QUERY_LIMITED_INFORMATION = 0x1001'), /is not the constant 0x1000/],
      ['an allowed call with a body', (s: string) => s.replace('[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);', 'public static bool CloseHandle(IntPtr handle) { return TerminateProcess(handle, 1); }'), /CloseHandle is not a P\/Invoke declaration/],
    ])('fails on %s', (_what, change, reason) => {
      const violations = portsCommandViolations(change(withBody('')))
      expect(violations.some((violation) => reason.test(violation)), violations.join('\n')).toBe(true)
    })
  })

  // Group 3 (task 3.3) adds the Windows inspector's import closure and tags both halves together.
  it.todo('[spec:port-inspection/windows-inspection-queries-only] the Windows inspector starts nothing itself, and the helper\'s ports opens processes for query only')

  it('the service receives nothing but the inspector and the attribution sets', () => {
    expectTypeOf<keyof PortServiceDeps>().toEqualTypeOf<'inspector' | 'attribution'>()
    expectTypeOf<keyof PortServiceDeps['inspector']>().toEqualTypeOf<'list'>()
    // The composition root hands it a function returning attribution sets, not the supervisor.
    const composition = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    expect(composition).toMatch(/createPortService\(\{ inspector: platform\.portInspector, attribution: \(\) => supervisor\.attribution\(\) \}\)/)
  })
})
