import { describe, expect, it } from 'vitest'
import { isRuntimeVariable, withoutRuntimeVariables } from '../../src/main/platform/runtime-env'
import type { CommandSpec, Env, ResolveResult } from '../../src/main/platform/types'
import { commandSpec, createPlanner } from '../../src/main/supervisor/plan'
import type { CommandConfig } from '../../src/shared/config'
import { command, project } from './support/config'

const target = (overrides: Partial<CommandConfig>) => {
  const cmd = command(overrides)
  return { project: project({ path: '/home/dev/shop', commands: [cmd] }), command: cmd }
}

describe('spawn planner', () => {
  it('describes direct and shell commands to the resolver', () => {
    const args = ['a b', '"quoted"', '$HOME', ';', '&', '|', '*']
    expect(commandSpec(target({ cwd: 'api', execution: { mode: 'direct', file: 'npm', args } }))).toEqual({
      mode: 'direct',
      file: 'npm',
      args,
      script: '',
      shellPath: null,
      projectRoot: '/home/dev/shop',
      cwd: 'api',
    })
    expect(commandSpec(target({ execution: { mode: 'shell', shell: '/bin/bash', script: 'npm run dev | tee log' } }))).toMatchObject({
      mode: 'shell',
      script: 'npm run dev | tee log',
      shellPath: '/bin/bash',
    })
  })

  it('[spec:project-registry/override-applied] resolves with the base environment and the overrides applied last', async () => {
    const seen: { spec: CommandSpec; env: Env }[] = []
    const plan = createPlanner({
      environment: { base: () => Promise.resolve({ env: { PATH: '/usr/bin', PORT: '80' }, warnings: [] }) },
      resolver: {
        resolve: (spec, env): Promise<ResolveResult> => {
          seen.push({ spec, env })
          return Promise.resolve({ ok: true, plan: { file: '/usr/bin/npm', args: [], cwd: '/home/dev/shop', env } })
        },
      },
    })
    const planned = await plan(target({ env: [{ key: 'PORT', value: '3000', secret: false }] }))
    expect(planned).toMatchObject({ ok: true, plan: { file: '/usr/bin/npm', env: { PATH: '/usr/bin', PORT: '3000' } } })
    expect(seen[0]?.env).toEqual({ PATH: '/usr/bin', PORT: '3000' })
  })

  it('passes resolver diagnostics on as the reason a start fails', async () => {
    const plan = createPlanner({
      environment: { base: () => Promise.resolve({ env: {}, warnings: [] }) },
      resolver: { resolve: () => Promise.resolve({ ok: false, diagnostics: ['The project folder is missing: /home/dev/shop'] }) },
    })
    expect(await plan(target({}))).toEqual({ ok: false, reason: 'The project folder is missing: /home/dev/shop' })
  })

  it("recognises Veydr's runtime variables", () => {
    expect(['ELECTRON_X', 'APPIMAGE', 'NO_AT_BRIDGE', 'CHROME_DESKTOP', 'PATH', 'ELECTRONX'].map(isRuntimeVariable)).toEqual([true, true, true, true, false, false])
    expect(withoutRuntimeVariables({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', APPDIR: '/tmp/.mount', UNSET: undefined })).toEqual({ PATH: '/bin' })
  })
})
