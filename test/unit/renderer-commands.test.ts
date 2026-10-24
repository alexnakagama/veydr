import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { describeExecution } from '../../src/renderer/src/App'
import { CommandEditor, SECRET_STORAGE_DISCLOSURE } from '../../src/renderer/src/CommandEditor'
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

const editor = (command: CommandView | null): string =>
  renderToStaticMarkup(
    createElement(CommandEditor, {
      projectId: '7a2e9b5d-4d2f-4f66-8b8c-1e7e2a3c0b12',
      projectName: 'shop',
      command,
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

  it('[spec:project-registry/shell-mode-labelled] shows the shell that interprets a shell command', () => {
    expect(editor(secretCommand)).toContain('Shell command — runs through /bin/bash')
    const added = editor(null)
    expect(added).toContain('Add command to shop')
    expect(added).not.toContain('Shell command — runs through')
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
