import { describe, expect, it } from 'vitest'
import { describeExit, describeSurvivors, formatUptime } from '../../src/renderer/src/process-format'
import { createLifecycleRequest } from '../../src/renderer/src/state/lifecycle'
import type { ApiResult, CommandProcessState } from '../../src/shared/api'

const commandId = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'

describe('process formatting', () => {
  it('formats uptime as m:ss or h:mm:ss, never negative', () => {
    expect([0, 999, 1_000, 65_000, 3_599_000, 3_600_000, 3_725_000, 90_061_000, -5_000].map(formatUptime)).toEqual([
      '0:00',
      '0:00',
      '0:01',
      '1:05',
      '59:59',
      '1:00:00',
      '1:02:05',
      '25:01:01',
      '0:00',
    ])
  })

  it('describes exits', () => {
    expect(describeExit({ code: 0, signal: null, forced: false })).toBe('Exited with code 0')
    expect(describeExit({ code: null, signal: 'SIGTERM', forced: false })).toBe('Terminated by SIGTERM')
    expect(describeExit({ code: null, signal: 'SIGKILL', forced: true })).toBe('Terminated by SIGKILL (forced after the stop timeout)')
    expect(describeExit({ code: null, signal: null, forced: true })).toBe('Exited (forced after the stop timeout)')
    expect(describeExit(null)).toBe('Exited')
  })

  it('lists survivors', () => {
    expect(describeSurvivors([{ pid: 1, name: 'node' }, { pid: 2, name: 'sh' }])).toBe('Still running after the stop: PID 1 (node), PID 2 (sh)')
  })
})

describe('lifecycle requests', () => {
  const state = { commandId } as CommandProcessState
  const answer = (result: ApiResult<CommandProcessState>) => () => Promise.resolve(result)

  it('sends each action to its operation and reports success as null', async () => {
    const calls: string[] = []
    const request = createLifecycleRequest({
      start: (r) => (calls.push(`start ${r.commandId}`), Promise.resolve({ ok: true, value: state })),
      stop: (r) => (calls.push(`stop ${r.commandId}`), Promise.resolve({ ok: true, value: state })),
      restart: (r) => (calls.push(`restart ${r.commandId}`), Promise.resolve({ ok: true, value: state })),
    })
    expect(await request('start', commandId)).toBeNull()
    expect(await request('stop', commandId)).toBeNull()
    expect(await request('restart', commandId)).toBeNull()
    expect(calls).toEqual([`start ${commandId}`, `stop ${commandId}`, `restart ${commandId}`])
  })

  it('reports error results and unreachable main as messages', async () => {
    const failing = answer({ ok: false, error: { code: 'unsupported_platform', message: 'processTree.spawn is not supported on this platform (win32)' } })
    const request = createLifecycleRequest({ start: failing, stop: failing, restart: () => Promise.reject(new Error('gone')) })
    expect(await request('start', commandId)).toBe('processTree.spawn is not supported on this platform (win32)')
    expect(await request('restart', commandId)).toBe('Could not reach the application.')
  })
})
