import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectStores } from '../../src/renderer/src/state'
import { contractEntries, type VeydrApi } from '../../src/shared/api'

// Operations with a real handler in this group (L2). Everything else answers `not_implemented`, so
// no UI path may call it until its task group lands; extend this list when one does.
const implemented = new Set(['app.getInfo', 'app.onNotice', 'projects.list', 'processes.snapshot', 'processes.onState', 'settings.get'])

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
