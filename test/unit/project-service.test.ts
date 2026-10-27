import type * as FsPromises from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { createConfigStore } from '../../src/main/config'
import { NotFoundError, UserError } from '../../src/main/errors'
import { createProjectService } from '../../src/main/projects/service'
import type { CommandInput } from '../../src/shared/api'
import type { EnvNameRule } from '../../src/shared/config'

/**
 * Folders that exist only for the service's `realpath` and `stat`, so its duplicate lookup can be
 * exercised with Windows paths, or with a case-sensitive filesystem, on any OS. They resolve to
 * themselves as typed, so a match comes from `projectPathKey` rather than from `realpath`
 * canonicalizing the case. Every other path goes to the real filesystem.
 */
const fakeFolders = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    realpath: (path: string, ...rest: []) => (fakeFolders.has(path) ? Promise.resolve(path) : actual.realpath(path, ...rest)),
    stat: (path: string, ...rest: []) => (fakeFolders.has(path) ? Promise.resolve({ isDirectory: () => true }) : actual.stat(path, ...rest)),
  }
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  fakeFolders.clear()
})

/** A fresh directory by its real path, the form the service stores (on Windows, `tmpdir()` may be an 8.3 short name such as `RUNNER~1`). */
function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

async function setup(options: { readOnly?: boolean; envNames?: EnvNameRule } = {}) {
  const configDir = tempDir('veydr-projects-config-')
  if (options.readOnly === true) writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schemaVersion: 99, projects: [] }))
  const store = createConfigStore({ dir: configDir, log: createDiagnosticLog(() => undefined) })
  await store.load()
  const active = new Set<string>()
  let ids = 0
  const service = createProjectService({
    store,
    activeCommands: () => active,
    envNames: options.envNames ?? 'exact',
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  })
  const work = tempDir('veydr-projects-work-')
  return { store, service, active, work, configDir }
}

const command = (overrides: Partial<CommandInput> = {}): CommandInput => ({
  id: null,
  name: 'api',
  execution: { mode: 'direct', file: 'node', args: ['server.js'] },
  cwd: '.',
  env: [],
  stopTimeoutMs: 5000,
  ...overrides,
})

const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

describe('project registration', () => {
  it('[spec:project-registry/register-valid-folder] registers an existing folder by its real path and persists it', async () => {
    const { service, store, work } = await setup()
    const folder = join(work, 'shop')
    mkdirSync(folder)
    const view = await service.add({ path: `${folder}/`, name: ' shop ' })
    expect(view).toMatchObject({ name: 'shop', path: folder, missing: false, commands: [] })
    expect(await service.list()).toEqual([view])
    expect(store.current().projects).toHaveLength(1)
  })

  it('[spec:project-registry/reject-non-directory] rejects a path that does not exist or is not a folder, with an explanation', async () => {
    const { service, work } = await setup()
    const file = join(work, 'file.txt')
    writeFileSync(file, 'x')
    const missing = await rejection(service.add({ path: join(work, 'nope'), name: 'x' }))
    expect(missing).toBeInstanceOf(UserError)
    expect(missing.message).toBe(`${join(work, 'nope')} does not exist.`)
    expect((await rejection(service.add({ path: file, name: 'x' }))).message).toBe(`${file} is not a folder.`)
    expect(await service.list()).toEqual([])
  })

  it('[spec:project-registry/reject-duplicate] rejects a folder that resolves to a registered project, naming it', async () => {
    const { service, work } = await setup()
    const folder = join(work, 'shop')
    mkdirSync(folder)
    symlinkSync(folder, join(work, 'link'))
    await service.add({ path: folder, name: 'shop' })
    for (const path of [folder, `${folder}/`, join(work, 'link'), join(work, 'link', '..', 'shop')]) {
      const error = await rejection(service.add({ path, name: 'again' }))
      expect(error).toBeInstanceOf(UserError)
      expect(error.message, path).toBe(`This folder is already registered as project "shop" (${folder}).`)
    }
    expect(await service.list()).toHaveLength(1)
  })

  it('[spec:project-registry/windows-path-differing-only-in-case] rejects a Windows folder registered again in different case', async () => {
    for (const [registered, again] of [
      ['C:\\Work\\Shop', 'c:\\work\\shop'],
      ['C:/Work/Shop/', 'c:\\work\\shop'],
    ] as const) {
      const { service, store } = await setup()
      fakeFolders.add(registered).add(again)
      await service.add({ path: registered, name: 'shop' })
      const before = store.current()
      const error = await rejection(service.add({ path: again, name: 'again' }))
      expect(error).toBeInstanceOf(UserError)
      expect(error.message, `${registered} / ${again}`).toBe(`This folder is already registered as project "shop" (${registered}).`)
      expect(store.current()).toEqual(before)
    }
  })

  it('[spec:project-registry/posix-path-differing-only-in-case] registers POSIX folders that differ only in case separately', async () => {
    const { service } = await setup()
    fakeFolders.add('/home/dev/Shop').add('/home/dev/shop')
    await service.add({ path: '/home/dev/Shop', name: 'Shop' })
    await service.add({ path: '/home/dev/shop', name: 'shop' })
    expect((await service.list()).map((p) => p.path)).toEqual(['/home/dev/Shop', '/home/dev/shop'])
  })

  it('renames a project', async () => {
    const { service, work } = await setup()
    const view = await service.add({ path: work, name: 'old' })
    expect(await service.rename({ projectId: view.id, name: 'new' })).toMatchObject({ id: view.id, name: 'new' })
    expect(await rejection(service.rename({ projectId: '00000000-0000-4000-8000-0000000000ff', name: 'x' }))).toBeInstanceOf(NotFoundError)
  })
})

describe('project removal', () => {
  it('[spec:project-registry/remove-idle-project] removes the project and its commands and leaves the folder unchanged', async () => {
    const { service, work } = await setup()
    writeFileSync(join(work, 'package.json'), '{"name":"shop"}')
    mkdirSync(join(work, 'src'))
    const before = readdirSync(work, { recursive: true }).sort()
    const view = await service.add({ path: work, name: 'shop' })
    await service.upsertCommand(view.id, command())
    await service.remove(view.id)
    expect(await service.list()).toEqual([])
    expect(readdirSync(work, { recursive: true }).sort()).toEqual(before)
    expect(readFileSync(join(work, 'package.json'), 'utf8')).toBe('{"name":"shop"}')
  })

  it('[spec:project-registry/remove-project-with-running-commands] refuses while a command may be running', async () => {
    const { service, work, active } = await setup()
    const view = await service.add({ path: work, name: 'shop' })
    const saved = await service.upsertCommand(view.id, command())
    active.add(saved.id)
    const error = await rejection(service.remove(view.id))
    expect(error).toBeInstanceOf(UserError)
    expect(error.message).toBe('Stop the running commands of "shop" first (api), then remove the project.')
    expect((await rejection(service.removeCommand(saved.id))).message).toBe('Stop "api" first, then remove it.')
    expect(await service.list()).toHaveLength(1)
    active.clear()
    await service.remove(view.id)
    expect(await service.list()).toEqual([])
  })
})

describe('missing and moved folders', () => {
  it('[spec:project-registry/directory-missing] lists a project whose folder was deleted as missing', async () => {
    const { service, work } = await setup()
    const folder = join(work, 'shop')
    mkdirSync(folder)
    const view = await service.add({ path: folder, name: 'shop' })
    rmSync(folder, { recursive: true })
    expect(await service.list()).toEqual([{ ...view, missing: true }])
  })

  it('[spec:project-registry/relocate-project] relocates a missing project to an existing folder, refusing duplicates and running projects', async () => {
    const { service, work, active } = await setup()
    const [a, b, c] = ['a', 'b', 'c'].map((name) => join(work, name))
    for (const dir of [a, b, c]) mkdirSync(dir ?? '')
    const project = await service.add({ path: a ?? '', name: 'a' })
    await service.add({ path: c ?? '', name: 'c' })
    rmSync(a ?? '', { recursive: true })
    expect(await rejection(service.relocate({ projectId: project.id, path: c ?? '' }))).toMatchObject({ message: expect.stringContaining('already registered as project "c"') as unknown })
    expect(await service.relocate({ projectId: project.id, path: b ?? '' })).toMatchObject({ path: b, missing: false })
    const saved = await service.upsertCommand(project.id, command())
    active.add(saved.id)
    mkdirSync(a ?? '')
    expect((await rejection(service.relocate({ projectId: project.id, path: a ?? '' }))).message).toBe('Stop the running commands of "a" first (api), then relocate the project.')
  })
})

describe('commands', () => {
  it('[spec:project-registry/multiple-commands] stores several commands per project', async () => {
    const { service, work } = await setup()
    const view = await service.add({ path: work, name: 'shop' })
    for (const name of ['api', 'web', 'worker']) await service.upsertCommand(view.id, command({ name }))
    const [listed] = await service.list()
    expect(listed?.commands.map((c) => c.name)).toEqual(['api', 'web', 'worker'])
    expect(new Set(listed?.commands.map((c) => c.id)).size).toBe(3)
  })

  it('[spec:project-registry/working-directory-outside-project-rejected] rejects a working directory outside the project, lexically and through links', async () => {
    const { service, work } = await setup()
    const root = join(work, 'shop')
    mkdirSync(join(root, 'api'), { recursive: true })
    symlinkSync(tmpdir(), join(root, 'escape'))
    const view = await service.add({ path: root, name: 'shop' })
    for (const cwd of ['..', '../other', 'api/../..']) {
      const error = await rejection(service.upsertCommand(view.id, command({ cwd })))
      expect(error, cwd).toBeInstanceOf(UserError)
      expect(error.message).toBe(`The working directory "${cwd}" is outside the project folder ${root}.`)
    }
    expect((await rejection(service.upsertCommand(view.id, command({ cwd: 'escape' })))).message).toContain('It resolves to')
    // Inside, including a folder that does not exist yet.
    for (const cwd of ['.', 'api', 'api/../api', 'later']) expect((await service.upsertCommand(view.id, command({ cwd }))).cwd).toBe(cwd)
  })

  it('[spec:project-registry/secret-masked-by-default] never returns secret values, keeps an unchanged secret, and reveals it on request', async () => {
    const { service, store, work } = await setup()
    const view = await service.add({ path: work, name: 'shop' })
    const saved = await service.upsertCommand(view.id, command({ env: [{ key: 'TOKEN', secret: true, value: 'hunter2' }, { key: 'PORT', secret: false, value: '3000' }] }))
    expect(saved.env).toEqual([
      { key: 'TOKEN', secret: true, value: null },
      { key: 'PORT', secret: false, value: '3000' },
    ])
    expect(JSON.stringify(await service.list())).not.toContain('hunter2')
    // Saved again without the value: the stored secret is kept.
    await service.upsertCommand(view.id, command({ id: saved.id, env: [{ key: 'TOKEN', secret: true, value: null }] }))
    expect(store.current().projects[0]?.commands[0]?.env).toEqual([{ key: 'TOKEN', value: 'hunter2', secret: true }])
    expect(service.revealSecret(saved.id, 'TOKEN')).toBe('hunter2')
    expect(() => service.revealSecret(saved.id, 'PORT')).toThrow(NotFoundError)
    // A new secret needs a value.
    expect((await rejection(service.upsertCommand(view.id, command({ id: saved.id, env: [{ key: 'OTHER', secret: true, value: null }] })))).message).toBe(
      'Enter a value for the secret variable "OTHER".',
    )
  })

  it('[spec:project-registry/overrides-differing-only-in-case-rejected-on-windows] rejects overrides naming one variable under a case-insensitive rule, saving nothing', async () => {
    const { service, store, work, configDir } = await setup({ envNames: 'case-insensitive' })
    const view = await service.add({ path: work, name: 'shop' })
    const saved = await service.upsertCommand(view.id, command({ env: [{ key: 'NODE_ENV', secret: false, value: 'production' }] }))
    const before = store.current()
    const env = [
      { key: 'NODE_ENV', secret: false, value: 'development' },
      { key: 'node_env', secret: false, value: 'test' },
    ]
    for (const input of [command({ env }), command({ id: saved.id, env })]) {
      const error = await rejection(service.upsertCommand(view.id, input))
      expect(error).toBeInstanceOf(UserError)
      expect(error.message).toBe('Duplicate variable "node_env"')
    }
    expect(store.current()).toBe(before)
    expect(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))).toMatchObject({ projects: [{ commands: [{ env: [{ key: 'NODE_ENV', value: 'production' }] }] }] })
  })

  it('keeps a stored secret renamed only in case under a case-insensitive rule, and not under an exact rule', async () => {
    for (const envNames of ['case-insensitive', 'exact'] as const) {
      const { service, store, work } = await setup({ envNames })
      const view = await service.add({ path: work, name: 'shop' })
      const saved = await service.upsertCommand(view.id, command({ env: [{ key: 'token', secret: true, value: 'hunter2' }] }))
      const renamed = service.upsertCommand(view.id, command({ id: saved.id, env: [{ key: 'TOKEN', secret: true, value: null }] }))
      if (envNames === 'exact') {
        expect((await rejection(renamed)).message).toBe('Enter a value for the secret variable "TOKEN".')
        continue
      }
      await renamed
      expect(store.current().projects[0]?.commands[0]?.env).toEqual([{ key: 'TOKEN', value: 'hunter2', secret: true }])
    }
  })

  it('accepts overrides differing only in case under an exact rule', async () => {
    const { service, work } = await setup({ envNames: 'exact' })
    const view = await service.add({ path: work, name: 'shop' })
    const env = [
      { key: 'NODE_ENV', secret: false, value: 'development' },
      { key: 'node_env', secret: false, value: 'test' },
    ]
    expect((await service.upsertCommand(view.id, command({ env }))).env.map((entry) => entry.key)).toEqual(['NODE_ENV', 'node_env'])
  })

  it('does not re-create a command removed while it was being saved', async () => {
    const { service, store, work } = await setup()
    const view = await service.add({ path: work, name: 'shop' })
    const saved = await service.upsertCommand(view.id, command())
    const update = store.update.bind(store)
    // The removal lands between the service's check and its configuration update.
    store.update = async (change) => {
      await update((c) => ({ ...c, projects: c.projects.map((p) => ({ ...p, commands: [] })) }))
      return update(change)
    }
    expect(await rejection(service.upsertCommand(view.id, command({ id: saved.id, name: 'renamed' })))).toBeInstanceOf(NotFoundError)
    expect(store.current().projects[0]?.commands).toEqual([])
  })

  it('refuses to edit a command through another project', async () => {
    const { service, work } = await setup()
    const a = await service.add({ path: work, name: 'a' })
    const other = tempDir('veydr-projects-other-')
    const b = await service.add({ path: other, name: 'b' })
    const saved = await service.upsertCommand(a.id, command())
    expect(await rejection(service.upsertCommand(b.id, command({ id: saved.id })))).toBeInstanceOf(NotFoundError)
  })
})

describe('settings', () => {
  it('saves and clears the editor', async () => {
    const { service } = await setup()
    expect(await service.setEditor({ file: 'code', args: ['--new-window', '{path}'] })).toEqual({ editor: { file: 'code', args: ['--new-window', '{path}'] } })
    expect(await service.setEditor(null)).toEqual({ editor: null })
  })

  it('explains that a read-only configuration cannot be changed', async () => {
    const { service, work } = await setup({ readOnly: true })
    const error = await rejection(service.add({ path: work, name: 'x' }))
    expect(error).toBeInstanceOf(UserError)
    expect(error.message).toBe('Configuration changes are disabled: it was created by a newer version of Veydr. Nothing was changed.')
  })
})
