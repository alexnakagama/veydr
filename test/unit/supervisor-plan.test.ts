import { describe, expect, it } from 'vitest'
import { createInterimPlanner, isRuntimeVariable, planCommand } from '../../src/main/supervisor/plan'
import type { CommandConfig } from '../../src/shared/config'
import { command, project } from './support/config'

const target = (overrides: Partial<CommandConfig>) => {
  const cmd = command(overrides)
  return { project: project({ path: '/home/dev/shop', commands: [cmd] }), command: cmd }
}

describe('interim spawn planner', () => {
  it('runs direct commands without a shell, arguments unchanged', () => {
    const args = ['a b', '"quoted"', '$HOME', ';', '&', '|', '*']
    expect(planCommand(target({ execution: { mode: 'direct', file: 'npm', args } }), { PATH: '/usr/bin' })).toEqual({
      ok: true,
      plan: { file: 'npm', args, cwd: '/home/dev/shop', env: { PATH: '/usr/bin' } },
    })
  })

  it('resolves a direct file with a slash against the working directory', () => {
    const planned = planCommand(target({ cwd: 'api', execution: { mode: 'direct', file: './bin/serve', args: [] } }), {})
    expect(planned).toMatchObject({ ok: true, plan: { file: '/home/dev/shop/api/bin/serve', cwd: '/home/dev/shop/api' } })
    expect(planCommand(target({ execution: { mode: 'direct', file: '/usr/bin/env', args: [] } }), {})).toMatchObject({ plan: { file: '/usr/bin/env' } })
  })

  it('runs shell commands as <shell> -c <script>', () => {
    expect(planCommand(target({ execution: { mode: 'shell', shell: '/bin/bash', script: 'npm run dev | tee log' } }), {})).toMatchObject({
      ok: true,
      plan: { file: '/bin/bash', args: ['-c', 'npm run dev | tee log'], cwd: '/home/dev/shop' },
    })
  })

  it('accepts working directories inside the project and rejects ones that leave it', () => {
    for (const cwd of ['.', 'api', 'api/../web', 'a/b/c', '..foo']) {
      expect(planCommand(target({ cwd }), {}).ok, cwd).toBe(true)
    }
    for (const cwd of ['..', '../other', 'api/../../other', 'a/../../..']) {
      expect(planCommand(target({ cwd }), {}), cwd).toEqual({
        ok: false,
        reason: `The working directory "${cwd}" is outside the project folder /home/dev/shop`,
      })
    }
  })

  it('applies overrides last, including secret values', () => {
    const planned = planCommand(
      target({
        env: [
          { key: 'PORT', value: '4000', secret: false },
          { key: 'TOKEN', value: 's3cret', secret: true },
        ],
      }),
      { PORT: '3000', PATH: '/bin' },
    )
    expect(planned).toMatchObject({ ok: true, plan: { env: { PORT: '4000', TOKEN: 's3cret', PATH: '/bin' } } })
  })

  it('removes Veydr runtime variables from the inherited environment', async () => {
    const plan = createInterimPlanner({
      PATH: '/bin',
      HOME: '/home/dev',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      APPIMAGE: '/x.AppImage',
      APPDIR: '/tmp/.mount',
      ARGV0: 'veydr',
      OWD: '/',
      CHROME_DESKTOP: 'veydr.desktop',
      UNSET: undefined,
    })
    const planned = await plan(target({ env: [{ key: 'ELECTRON_OVERRIDE', value: 'kept', secret: false }] }))
    // An explicit override is the user's choice and is kept.
    expect(planned).toMatchObject({ ok: true, plan: { env: { PATH: '/bin', HOME: '/home/dev', ELECTRON_OVERRIDE: 'kept' } } })
    expect(planned.ok && Object.keys(planned.plan.env).sort()).toEqual(['ELECTRON_OVERRIDE', 'HOME', 'PATH'])
    expect(['ELECTRON_X', 'APPIMAGE', 'PATH', 'ELECTRONX'].map(isRuntimeVariable)).toEqual([true, true, false, false])
  })
})
