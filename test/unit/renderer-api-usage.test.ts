import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectStores } from '../../src/renderer/src/state'
import { createLifecycleRequest } from '../../src/renderer/src/state/lifecycle'
import { createSurvivorRequest } from '../../src/renderer/src/state/survivors'
import { contractEntries, type VeydrApi } from '../../src/shared/api'

// Operations with a real handler (L2–L5). Everything else answers `not_implemented`, so no UI path
// may call it until its task group lands; extend this list when one does.
const implemented = new Set([
  'app.getInfo',
  'app.onNotice',
  'projects.list',
  'projects.pickDirectory',
  'projects.add',
  'projects.update',
  'projects.remove',
  'projects.relocate',
  'projects.openFolder',
  'projects.openInEditor',
  'commands.upsert',
  'commands.remove',
  'commands.previewEnvironment',
  'commands.revealSecret',
  'settings.setEditor',
  'processes.snapshot',
  'processes.onState',
  'processes.start',
  'processes.stop',
  'processes.restart',
  'processes.resolveSurvivors',
  'settings.get',
])

/** An API whose every function records its use and answers like main does for the operation. */
function recordingApi(used: Set<string>): VeydrApi {
  const api: Record<string, Record<string, unknown>> = {}
  for (const { group, name, spec } of contractEntries) {
    const ops = (api[group] ??= {})
    ops[name] =
      spec.kind === 'event'
        ? () => {
            used.add(`${group}.${name}`)
            return () => undefined
          }
        : () => {
            used.add(`${group}.${name}`)
            if (name === 'list') return Promise.resolve({ ok: true, value: [] })
            if (name === 'snapshot') return Promise.resolve({ ok: true, value: { commands: [] } })
            return Promise.resolve({ ok: false, error: { code: 'not_implemented', message: `${group}.${name} is not implemented yet` } })
          }
  }
  return api as unknown as VeydrApi
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe('renderer use of staged operations', () => {
  it('connects the stores using implemented operations only', () => {
    const used = new Set<string>()
    connectStores(recordingApi(used))
    expect([...used].filter((op) => !implemented.has(op))).toEqual([])
    expect(used.size).toBeGreaterThan(0)
  })

  it('requests lifecycle actions through implemented operations only', async () => {
    const used = new Set<string>()
    const request = createLifecycleRequest(recordingApi(used).processes)
    for (const action of ['start', 'stop', 'restart'] as const) await request(action, '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01')
    expect([...used].sort()).toEqual(['processes.restart', 'processes.start', 'processes.stop'])
    expect([...used].filter((op) => !implemented.has(op))).toEqual([])
  })

  it('resolves crash survivors through processes.resolveSurvivors only, reporting failures', async () => {
    const used = new Set<string>()
    const request = createSurvivorRequest(recordingApi(used).processes)
    // The recording API answers like a not-yet-implemented operation: the failure is passed on.
    expect(await request('terminate')).toMatchObject({ ok: false })
    expect([...used]).toEqual(['processes.resolveSurvivors'])

    const calls: unknown[] = []
    const ok = createSurvivorRequest({
      resolveSurvivors: (req) => {
        calls.push(req)
        return Promise.resolve({ ok: true, value: { remaining: [{ pid: 7, name: 'node' }] } })
      },
    })
    expect(await ok('dismiss')).toEqual({ ok: true, remaining: [{ pid: 7, name: 'node' }] })
    expect(calls).toEqual([{ action: 'dismiss' }])
    const unreachable = createSurvivorRequest({ resolveSurvivors: () => Promise.reject(new Error('gone')) })
    expect(await unreachable('terminate')).toEqual({ ok: false, message: 'Could not reach the application.' })
  })

  it('references window.veydr only for implemented operations, and has no retry of failed requests', () => {
    const root = join(__dirname, '../../src/renderer/src')
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/veydr\.(\w+)\s*\.\s*(\w+)/g)) {
        expect(implemented.has(`${match[1]}.${match[2]}`), `${file}: ${match[0]}`).toBe(true)
      }
      expect(text, file).not.toMatch(/not_implemented|retry/i)
    }
  })
})
