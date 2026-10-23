import { describe, expect, it } from 'vitest'
import {
  configSchema,
  DEFAULT_STOP_TIMEOUT_MS,
  emptyConfig,
  isAbsolutePath,
  projectPathKey,
  validateConfig,
  type Config,
} from '../../src/shared/config'
import { command, config, project } from './support/config'

function issuesOf(input: unknown): { path: string; message: string }[] {
  const result = validateConfig(input)
  if (result.ok) throw new Error('expected the document to be invalid')
  return [...result.issues]
}

const DELETE = Symbol('delete')

/** Returns a copy of a valid document with the value at `path` replaced (or deleted). */
function variant(path: readonly (string | number)[], value: unknown): unknown {
  const doc = structuredClone(config()) as unknown
  let node = doc as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>
  const last = path.at(-1) as string | number
  if (value === DELETE) delete node[last]
  else node[last] = value
  return doc
}

const firstCommand = ['projects', 0, 'commands', 0] as const

describe('config schema v1: valid documents', () => {
  it('accepts the empty configuration', () => {
    expect(validateConfig(emptyConfig())).toEqual({ ok: true, config: emptyConfig() })
  })

  it('accepts projects with direct and shell commands, env overrides, and an editor', () => {
    const doc: Config = {
      schemaVersion: 1,
      projects: [
        project({
          commands: [
            command({ env: [{ key: 'API_TOKEN', value: 's3cret', secret: true }, { key: 'EMPTY', value: '', secret: false }] }),
            command({ name: 'web', execution: { mode: 'shell', shell: '/bin/bash', script: 'npm run dev | tee out' }, cwd: 'web' }),
            command({ name: 'worker', stopTimeoutMs: 0, execution: { mode: 'direct', file: './bin/worker', args: [] } }),
          ],
        }),
        project({ path: '/home/dev/blog', commands: [] }),
      ],
      settings: { editor: { file: 'code', args: ['--new-window', '{path}'] } },
    }
    const result = validateConfig(doc)
    expect(result).toEqual({ ok: true, config: doc })
  })

  it('accepts arguments with shell metacharacters as plain data', () => {
    const args = ['a b', '"q"', "'s'", '$HOME', 'x;y', 'a&b', 'a|b', '*']
    expect(validateConfig(variant([...firstCommand, 'execution', 'args'], args)).ok).toBe(true)
  })

  it('exports a 5 s default stop timeout', () => {
    expect(DEFAULT_STOP_TIMEOUT_MS).toBe(5000)
  })
})

describe('config schema v1: invalid documents', () => {
  const env = (...entries: unknown[]) => variant([...firstCommand, 'env'], entries)
  const execution = (value: unknown) => variant([...firstCommand, 'execution'], value)
  const base = config()
  const [first] = base.projects
  if (first === undefined) throw new Error('fixture has no project')
  const withProjects = (...extra: unknown[]) => ({ ...base, projects: [first, ...extra] })

  const cases: [string, unknown, string, string][] = [
    ['missing schemaVersion', variant(['schemaVersion'], DELETE), 'schemaVersion', ''],
    ['other schemaVersion', variant(['schemaVersion'], 2), 'schemaVersion', ''],
    ['unknown top-level key', variant(['extra'], true), '', 'extra'],
    ['missing settings', variant(['settings'], DELETE), 'settings', ''],
    ['non-UUID project id', variant(['projects', 0, 'id'], 'p1'), 'projects[0].id', 'UUID'],
    ['blank project name', variant(['projects', 0, 'name'], '   '), 'projects[0].name', 'empty'],
    ['overlong project name', variant(['projects', 0, 'name'], 'x'.repeat(201)), 'projects[0].name', '200'],
    ['relative project path', variant(['projects', 0, 'path'], 'shop'), 'projects[0].path', 'absolute'],
    ['NUL in project path', variant(['projects', 0, 'path'], '/a\0b'), 'projects[0].path', 'NUL'],
    ['unknown execution mode', execution({ mode: 'pty', file: 'x', args: [] }), 'projects[0].commands[0].execution.mode', ''],
    ['empty executable', variant([...firstCommand, 'execution', 'file'], ''), 'projects[0].commands[0].execution.file', 'empty'],
    ['NUL in an argument', variant([...firstCommand, 'execution', 'args'], ['a\0']), 'projects[0].commands[0].execution.args[0]', 'NUL'],
    ['shell mode without a shell', execution({ mode: 'shell', script: 'ls' }), 'projects[0].commands[0].execution.shell', ''],
    ['relative shell path', execution({ mode: 'shell', shell: 'bash', script: 'ls' }), 'projects[0].commands[0].execution.shell', 'absolute'],
    ['empty shell script', execution({ mode: 'shell', shell: '/bin/sh', script: '' }), 'projects[0].commands[0].execution.script', 'empty'],
    ['shell fields in direct mode', variant([...firstCommand, 'execution', 'script'], 'ls'), 'projects[0].commands[0].execution', 'script'],
    ['absolute working directory', variant([...firstCommand, 'cwd'], '/tmp'), 'projects[0].commands[0].cwd', 'relative'],
    ['empty working directory', variant([...firstCommand, 'cwd'], ''), 'projects[0].commands[0].cwd', 'empty'],
    ['env key with "="', env({ key: 'A=B', value: '1', secret: false }), 'projects[0].commands[0].env[0].key', '='],
    ['empty env key', env({ key: '', value: '1', secret: false }), 'projects[0].commands[0].env[0].key', 'empty'],
    ['env entry without secret flag', env({ key: 'A', value: '1' }), 'projects[0].commands[0].env[0].secret', ''],
    ['duplicate env key', env({ key: 'A', value: '1', secret: false }, { key: 'A', value: '2', secret: true }), 'projects[0].commands[0].env[1].key', 'Duplicate'],
    ['fractional stop timeout', variant([...firstCommand, 'stopTimeoutMs'], 1.5), 'projects[0].commands[0].stopTimeoutMs', 'whole'],
    ['negative stop timeout', variant([...firstCommand, 'stopTimeoutMs'], -1), 'projects[0].commands[0].stopTimeoutMs', 'negative'],
    ['excessive stop timeout', variant([...firstCommand, 'stopTimeoutMs'], 300_001), 'projects[0].commands[0].stopTimeoutMs', '300000'],
    ['editor without {path}', variant(['settings', 'editor'], { file: 'code', args: ['.'] }), 'settings.editor.args', '{path}'],
    ['duplicate project id', withProjects({ ...first, path: '/other', commands: [] }), 'projects[1].id', 'Duplicate'],
    ['duplicate project path', withProjects({ ...first, id: crypto.randomUUID(), commands: [] }), 'projects[1].path', 'already registered'],
    ['duplicate path with a trailing separator', withProjects({ ...first, id: crypto.randomUUID(), path: `${first.path}/`, commands: [] }), 'projects[1].path', 'already registered'],
    ['duplicate command id', withProjects(project({ path: '/other', commands: first.commands })), 'projects[1].commands[0].id', 'Duplicate'],
  ]

  for (const [name, input, path, fragment] of cases) {
    it(`rejects ${name} and names the field`, () => {
      const issues = issuesOf(input)
      const match = issues.find((issue) => issue.path === path)
      expect(match, JSON.stringify(issues)).toBeDefined()
      if (fragment !== '') expect(`${match?.message} ${JSON.stringify(issues)}`).toContain(fragment)
    })
  }

  it('rejects non-objects', () => {
    for (const input of [null, [], 'config', 1]) expect(validateConfig(input).ok).toBe(false)
  })

  it('does not transform data while validating', () => {
    const doc = config()
    const parsed = configSchema.parse(structuredClone(doc))
    expect(parsed).toEqual(doc)
  })
})

describe('projectPathKey', () => {
  it('ignores trailing separators but keeps roots', () => {
    expect(projectPathKey('/a/b/')).toBe('/a/b')
    expect(projectPathKey('/a/b//')).toBe('/a/b')
    expect(projectPathKey('/a/b')).toBe('/a/b')
    expect(projectPathKey('C:\\work\\')).toBe('C:\\work')
    for (const root of ['/', '//', 'C:\\', 'C:/', '\\\\']) expect(projectPathKey(root), root).toBe(root)
  })
})

describe('isAbsolutePath', () => {
  it('recognises POSIX, Windows drive and UNC paths only', () => {
    for (const p of ['/', '/home/a', 'C:\\x', 'c:/x', '\\\\server\\share']) expect(isAbsolutePath(p), p).toBe(true)
    for (const p of ['', '.', 'a/b', '..\\x', 'C:', 'C:x', '~/x']) expect(isAbsolutePath(p), p).toBe(false)
  })
})
