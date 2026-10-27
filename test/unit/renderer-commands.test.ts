import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { describeExecution, editorConventions } from '../../src/renderer/src/App'
import {
  CommandEditor,
  draftFrom,
  inputFrom,
  withDefaultShell,
  isUnredactableSecret,
  SECRET_REDACTION_NOTE,
  SECRET_STORAGE_DISCLOSURE,
  SHORT_SECRET_WARNING,
  type Draft,
  type EditorConventions,
} from '../../src/renderer/src/CommandEditor'
import { folderName } from '../../src/renderer/src/ProjectDialogs'
import { shortcutFor } from '../../src/renderer/src/shortcuts'
import { createProjectActions } from '../../src/renderer/src/state/actions'
import type { CommandView, VeydrApi } from '../../src/shared/api'

const secretCommand: CommandView = {
  id: '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01',
  name: 'api',
  execution: { mode: 'shell', shell: '/bin/bash', script: 'npm run dev' },
  cwd: '.',
  env: [
    { key: 'TOKEN', secret: true, value: null },
    { key: 'PORT', secret: false, value: '3000' },
  ],
  stopTimeoutMs: 5000,
}

const linux: EditorConventions = { defaultShell: '/bin/sh', envNames: 'exact' }
const windows: EditorConventions = { defaultShell: null, envNames: 'case-insensitive' }

const editor = (command: CommandView | null, conventions: EditorConventions = linux): string =>
  renderToStaticMarkup(
    createElement(CommandEditor, {
      projectId: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
      projectName: 'shop',
      command,
      conventions,
      actions: { saveCommand: () => Promise.reject(new Error('unused')), revealSecret: () => Promise.reject(new Error('unused')) },
      onSaved: () => undefined,
      onClose: () => undefined,
    }),
  )

describe('command editor', () => {
  it('[spec:project-registry/secret-masked-by-default] masks secret values and shows the plaintext-storage disclosure', () => {
    const html = editor(secretCommand)
    expect(html).toContain(SECRET_STORAGE_DISCLOSURE.replace(/'/g, '&#x27;'))
    expect(html).toMatch(/<input type="password" aria-label="Variable 1 value"[^>]* value=""/)
    expect(html).toContain('placeholder="unchanged (hidden)"')
    expect(html).toMatch(/<input type="text" aria-label="Variable 2 value"[^>]* value="3000"/)
    expect(html).toContain('Reveal variable 1')
  })

  it('states that redaction from output is best effort, and warns about secrets too short to redact', () => {
    const html = editor(secretCommand)
    expect(html).toContain(SECRET_REDACTION_NOTE.replace(/'/g, '&#x27;'))
    expect(SECRET_REDACTION_NOTE).toMatch(/transformed, split, or partial values are not detected/)
    expect(SHORT_SECRET_WARNING).toContain('shorter than 4 characters')
    // A stored secret's value is unknown here (masked), so it cannot be judged.
    expect(html).not.toContain('short-secret-warning')
    expect([isUnredactableSecret(true, 'abc'), isUnredactableSecret(true, 'abcd'), isUnredactableSecret(false, 'ab'), isUnredactableSecret(true, ''), isUnredactableSecret(true, null)]).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
  })

  it('[spec:project-registry/shell-mode-labelled] shows the shell that interprets a shell command', () => {
    expect(editor(secretCommand)).toContain('Shell command — runs through /bin/bash')
    const added = editor(null)
    expect(added).toContain('Add command to shop')
    expect(added).not.toContain('Shell command — runs through')
  })
})

describe('command editor validation', () => {
  const shellDraft = (shell: string, conventions: EditorConventions = linux): Draft => ({ ...draftFrom(null, conventions.defaultShell), name: 'api', mode: 'shell', shell, script: 'npm run dev' })
  const withEnv = (...keys: string[]): Draft => ({
    ...shellDraft('/bin/sh'),
    env: keys.map((key, index) => ({ rowId: index + 1, key, secret: false, value: '1', storedKey: null, revealed: false })),
  })

  it('accepts an absolute shell path of either syntax', () => {
    for (const shell of ['C:\\Windows\\System32\\cmd.exe', '/bin/sh', '\\\\server\\share\\sh.exe']) {
      const input = inputFrom(shellDraft(shell), null, linux)
      expect(input, shell).toMatchObject({ execution: { mode: 'shell', shell, script: 'npm run dev' } })
    }
  })

  it('drops spaces around the shell path', () => {
    expect(inputFrom(shellDraft(' /bin/sh '), null, linux)).toMatchObject({ execution: { shell: '/bin/sh' } })
    expect(inputFrom(shellDraft('   ', windows), null, windows)).toBe('Enter the shell that runs the script.')
  })

  it('rejects a relative shell path, naming the default shell as example only when there is one', () => {
    expect(inputFrom(shellDraft('bin/sh'), null, linux)).toBe('The shell must be an absolute path, e.g. /bin/sh.')
    expect(inputFrom(shellDraft('bin/sh', windows), null, windows)).toBe('The shell must be an absolute path.')
    expect(inputFrom(shellDraft('', windows), null, windows)).toBe('Enter the shell that runs the script.')
  })

  it('starts a new shell command with the default shell from the app info, or an empty field without one', () => {
    expect(draftFrom(null, '/bin/sh').shell).toBe('/bin/sh')
    expect(draftFrom(null, null).shell).toBe('')
    expect(draftFrom({ ...secretCommand, env: [] }, null).shell).toBe('/bin/bash')
    const info = { name: 'Veydr', version: '0.0.0', platform: 'windows', platformSupported: false, versions: { electron: '1', chrome: '1', node: '1' } } as const
    expect(editorConventions({ status: 'ready', info: { ...info, defaultShell: null, envNames: 'case-insensitive' } })).toEqual(windows)
    expect(editorConventions({ status: 'ready', info: { ...info, platform: 'linux', platformSupported: true, defaultShell: '/bin/sh', envNames: 'exact' } })).toEqual(linux)
    expect(editorConventions({ status: 'loading' })).toEqual({ defaultShell: null, envNames: 'exact' })
    expect(editor(null, windows)).toContain('Add command to shop')
  })

  it('fills in a default shell that arrives after the editor opened, never replacing an entered one', () => {
    const opened = draftFrom(null, null)
    expect(withDefaultShell(opened, '/bin/sh').shell).toBe('/bin/sh')
    expect(withDefaultShell({ ...opened, shell: '/bin/bash' }, '/bin/sh').shell).toBe('/bin/bash')
    expect(withDefaultShell(opened, null)).toBe(opened)
  })

  it('labels a shell command without a shell', () => {
    expect(editor({ ...secretCommand, execution: { mode: 'shell', shell: '/bin/zsh', script: 'x' } })).toContain('Shell command — runs through /bin/zsh')
    expect(editor({ ...secretCommand, env: [], execution: { mode: 'shell', shell: '', script: 'x' } }, windows)).toContain('Shell command — enter the shell that runs it below')
  })

  it('flags variables that name the same variable under the platform rule, with the message main uses', () => {
    expect(inputFrom(withEnv('PATH', 'Path'), null, windows)).toBe('Duplicate variable "Path"')
    expect(inputFrom(withEnv('PATH', 'Path'), null, linux)).toMatchObject({ env: [{ key: 'PATH' }, { key: 'Path' }] })
    expect(inputFrom(withEnv('PATH', 'PATH'), null, linux)).toBe('Duplicate variable "PATH"')
    // A stored secret (value unknown here) still counts: the duplicate is reported before the secret checks.
    const stored = { ...withEnv('TOKEN'), env: [{ rowId: 1, key: 'TOKEN', secret: true, value: null, storedKey: 'TOKEN', revealed: false }] }
    expect(inputFrom({ ...stored, env: [...stored.env, { rowId: 2, key: 'token', secret: false, value: '1', storedKey: null, revealed: false }] }, null, windows)).toBe('Duplicate variable "token"')
  })
})

describe('command list text', () => {
  it('shows arguments that contain spaces or quotes quoted', () => {
    expect(describeExecution({ mode: 'direct', file: 'node', args: ['a b', 'say "hi"', '$HOME', ''] })).toBe('node "a b" "say \\"hi\\"" $HOME ""')
    expect(describeExecution({ mode: 'shell', shell: '/bin/sh', script: 'npm run dev | tee log' })).toBe('npm run dev | tee log')
  })

  it('suggests the folder name as project name', () => {
    expect(folderName('/home/dev/shop')).toBe('shop')
    expect(folderName('/home/dev/shop/')).toBe('shop')
    expect(folderName('/')).toBe('/')
  })
})

describe('keyboard shortcuts', () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
    key: k,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    defaultPrevented: false,
    ...extra,
  })

  it('maps single keys to commands and ignores modified, repeated, or handled keys', () => {
    expect(['s', 'x', 'r', '/', 'j', 'k', '?', 'q'].map((k) => shortcutFor(key(k)))).toEqual(['start', 'stop', 'restart', 'filter', 'next-project', 'previous-project', 'help', null])
    expect(shortcutFor(key('s', { ctrlKey: true }))).toBeNull()
    expect(shortcutFor(key('s', { altKey: true }))).toBeNull()
    expect(shortcutFor(key('s', { metaKey: true }))).toBeNull()
    expect(shortcutFor(key('s', { repeat: true }))).toBeNull()
    expect(shortcutFor(key('s', { defaultPrevented: true }))).toBeNull()
    expect(shortcutFor(key('s', { target: { tagName: 'INPUT' } as unknown as EventTarget }))).toBeNull()
    expect(shortcutFor(key('s', { target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }))).toBeNull()
    expect(shortcutFor(key('s', { target: { tagName: 'BUTTON' } as unknown as EventTarget }))).toBe('start')
  })
})

describe('project actions', () => {
  it('reloads the project list after a successful change only, and passes failures on as messages', async () => {
    let reloads = 0
    const api = {
      projects: {
        add: () => Promise.resolve({ ok: true, value: { id: 'p', name: 'x', path: '/x', missing: false, commands: [] } }),
        remove: () => Promise.resolve({ ok: false, error: { code: 'rejected', message: 'Stop the running commands first' } }),
        openFolder: () => Promise.reject(new Error('gone')),
      },
      commands: {},
      settings: {},
    } as unknown as Pick<VeydrApi, 'projects' | 'commands' | 'settings'>
    const actions = createProjectActions(api, () => {
      reloads++
      return Promise.resolve()
    })
    expect(await actions.addProject('/x', 'x')).toMatchObject({ ok: true })
    expect(reloads).toBe(1)
    expect(await actions.removeProject('p')).toEqual({ ok: false, message: 'Stop the running commands first' })
    expect(await actions.openFolder('p')).toEqual({ ok: false, message: 'Could not reach the application.' })
    expect(reloads).toBe(1)
  })
})
