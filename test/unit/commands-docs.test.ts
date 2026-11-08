import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOGIN_SHELL_TIMEOUT_MS } from '../../src/main/platform/linux/environment'
import { selectPlatform } from '../../src/main/platform'
import { isRuntimeVariable } from '../../src/main/platform/runtime-env'
import { BARE_BATCH_ARGUMENT, CMD_MAX_LINE, SHIM_LINE_RESERVE } from '../../src/main/platform/windows/command-line'
import { ACCEPTED_PROGRAM_TYPES, DEFAULT_PATHEXT, MAX_UNANSWERED_DIRECTORIES, PATH_DIRECTORY_TIMEOUT_MS } from '../../src/main/platform/windows/resolver'
import { SECRET_STORAGE_DISCLOSURE } from '../../src/renderer/src/CommandEditor'

const root = join(__dirname, '../..')
const doc = readFileSync(join(root, 'docs/commands.md'), 'utf8')
const section = (title: string): string => doc.split('\n## ').find((part) => part.startsWith(`${title}\n`)) ?? ''
/** Code spans of a Markdown text, with table-escaped pipes restored. */
const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? '').replaceAll('\\|', '|'))

describe('docs/commands.md', () => {
  it('uses examples that the end-to-end tests use', () => {
    const e2e = ['test/e2e/commands.spec.ts', 'test/e2e/projects.spec.ts'].map((file) => readFileSync(join(root, file), 'utf8')).join('\n')
    const examples = codeSpans(section('Examples')).filter((span) => !span.startsWith('test/'))
    expect(examples.length).toBeGreaterThan(8)
    for (const example of examples) {
      // A `<placeholder>` stands for a value the test computes; the text before it must match.
      const literal = example.split('<')[0] ?? ''
      expect(e2e, example).toContain(literal)
    }
  })

  it('states the timeout, default shell, and runtime variables of the code', () => {
    expect(doc).toContain(`takes longer than ${LOGIN_SHELL_TIMEOUT_MS / 1000} seconds`)
    expect(doc).toContain(`The shell defaults to \`${selectPlatform('linux').conventions.defaultShell}\``)
    const line = section('Environment').split('\n').find((l) => l.includes('runtime variables never reach')) ?? ''
    const listed = codeSpans(line.split("The shell's own")[0] ?? '')
    expect(listed.filter((name) => name !== 'ELECTRON_*')).toEqual(['NO_AT_BRIDGE', 'CHROME_DESKTOP', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'])
    for (const name of listed) expect(isRuntimeVariable(name.replace('*', 'X')), name).toBe(true)
  })

  it('discloses plaintext secret storage like the editor does', () => {
    expect(section('Secrets')).toContain('**stored unencrypted**')
    expect(SECRET_STORAGE_DISCLOSURE).toContain('stores them unencrypted')
  })

  it('states the Windows rules of the resolver and the command lines, as not yet reachable from the app', () => {
    const windows = section('Windows (not yet available)')
    // Labelled as not reachable from the app, before anything else is said.
    expect(windows.slice(windows.indexOf('\n')).trimStart().startsWith('**Not yet reachable from the app.**')).toBe(true)
    const sub = (title: string): string => windows.split('\n### ').find((part) => part.startsWith(`${title}\n`)) ?? ''
    const lookup = sub('Finding the program')
    expect(lookup).toContain('**The working directory is never searched**')
    expect(lookup).toContain(`(\`${DEFAULT_PATHEXT}\` when \`PATHEXT\` is unset or lists no usable extension)`)
    expect(lookup).toContain(`has ${PATH_DIRECTORY_TIMEOUT_MS / 1000} seconds to answer`)
    expect(lookup).toContain(`After ${MAX_UNANSWERED_DIRECTORIES} directories that do not answer, the search stops`)
    expect(lookup).toContain('only .exe, .com, .bat and .cmd files are started')
    expect(ACCEPTED_PROGRAM_TYPES.map((type) => `\`${type}\``).join(', ')).toBe('`.exe`, `.com`, `.bat`, `.cmd`')
    expect(lookup).toContain('`C:tool.exe`')
    expect(lookup).toContain('`\\tools\\tool.exe`')
    const batch = sub('Batch files')
    expect(batch).toContain('`cmd.exe /d /v:off /s /c`')
    // The simple-argument characters are exactly those of the code's pattern.
    expect(BARE_BATCH_ARGUMENT.source).toBe('^[A-Za-z0-9_+\\-.:/\\\\@]+$')
    expect(batch).toContain('ASCII letters, digits and `_ + - . : / \\ @`')
    expect(batch).toContain(`${CMD_MAX_LINE} characters for the whole line, of which ${SHIM_LINE_RESERVE} are kept free`)
    expect(batch).toContain('through `%1` itself')
    const shell = sub('Shell mode')
    expect(shell).toContain('On Windows, shell mode supports cmd.exe only')
    expect(shell).toContain(`**${CMD_MAX_LINE} characters.**`)
    expect(shell).toContain('join the commands with `&&` or `&`')
    expect(sub('`cmd.exe` as a direct-mode program')).toContain('use shell mode to run a script')
    const environment = sub('Environment')
    expect(environment).toContain('**Inherited.**')
    expect(environment).toContain('`=C:`')
    expect(environment).toContain('`environment.names-merged`, with the names but not the values')
    expect(environment).toContain('a command sees exactly one `PATH`')
    expect(environment).toContain('**A restart is needed after a `PATH` change.**')
    expect(environment).toContain('**Refresh environment** reads nothing new on Windows')
    const editor = sub('Editor')
    expect(editor).toContain('`code` finds `code.cmd` on `Path`')
    expect(editor).toContain('keeps running when Veydr quits')
    expect(editor).toContain('**No new console window**')
    expect(editor).toContain("**A batch-file editor that starts a console program shows that program's console**")
  })
})
