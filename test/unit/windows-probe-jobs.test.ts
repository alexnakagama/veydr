import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECKS, PROBE_AREAS } from '../../scripts/windows-probe/checks.mjs'
import { IdentityError, identityLine } from '../../scripts/windows-probe/identity.mjs'
import { NOT_IMPLEMENTED, placeholderLines } from '../../scripts/windows-probe/placeholder.mjs'
import { NO_RESULT, parseResults, summarize } from '../../scripts/windows-probe/summary.mjs'

// What every job of windows-probe.yml runs before and instead of a probe (tasks 2.3): the identity
// line that starts its results file (design D4), and the placeholder that answers nothing for an
// area whose probe is not implemented yet.

const root = join(__dirname, '../..')
const env = { ImageOS: 'win25', ImageVersion: '20261020.1.0', NEGATIVE_CONTROL: 'false' }
const identity = (overrides: Partial<Parameters<typeof identityLine>[0]> = {}): string =>
  identityLine({ area: 'ports', env, windowsBuild: '10.0.26100.6899', node: 'v24.11.1', ...overrides })

/** The problems IdentityError lists for these inputs, or [] if the line is accepted. */
const identityProblems = (overrides: Partial<Parameters<typeof identityLine>[0]>): readonly string[] => {
  try {
    identity(overrides)
    return []
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityError)
    return (error as IdentityError).problems
  }
}

describe('identityLine', () => {
  it('writes the identity line summary.mjs reads', () => {
    const line = identity()
    expect(line).not.toContain('\n')
    expect(parseResults(`${line}\n`, 'ports.jsonl')?.identity).toEqual({
      area: 'ports',
      imageOS: 'win25',
      imageVersion: '20261020.1.0',
      windowsBuild: '10.0.26100.6899',
      node: 'v24.11.1',
      negativeControl: false,
    })
    expect(parseResults(identity({ env: { ...env, NEGATIVE_CONTROL: 'true' } }), 'ports.jsonl')?.identity.negativeControl).toBe(true)
    for (const area of PROBE_AREAS) expect(parseResults(identity({ area }), `${area}.jsonl`)?.identity.area).toBe(area)
  })

  it('refuses an identity the summary would reject, listing every problem', () => {
    expect(identityProblems({ area: 'context' })).toEqual([expect.stringContaining('area must be one of')])
    expect(identityProblems({ env: { NEGATIVE_CONTROL: 'false' } })).toEqual([expect.stringContaining('ImageOS must be set'), expect.stringContaining('ImageVersion must be set')])
    expect(identityProblems({ env: { ...env, ImageVersion: '2026 1' } })).toEqual([expect.stringContaining('ImageVersion must be set, without spaces')])
    for (const flag of [undefined, '', 'yes', 'TRUE', '1']) {
      expect(identityProblems({ env: { ...env, NEGATIVE_CONTROL: flag } }), String(flag)).toEqual([expect.stringContaining('NEGATIVE_CONTROL must be "true" or "false"')])
    }
    // PowerShell prints an empty UBR as a trailing dot when the registry value is missing.
    for (const build of ['', '10.0.26100', '10.0.26100.', '10.0.26100.0\r\n1']) {
      expect(identityProblems({ windowsBuild: build }), build).toEqual([expect.stringContaining('Windows build must be four numbers')])
    }
    expect(identityProblems({ node: '' })).toEqual([expect.stringContaining('Node version')])
    expect(identityProblems({ area: 'x', env: {}, windowsBuild: '', node: '' })).toHaveLength(6)
  })
})

describe('placeholderLines', () => {
  const file = (area: string): string => [identity({ area }), ...placeholderLines(area)].join('\n')

  it('answers nothing, with the reason, from the context each check requires', () => {
    for (const area of PROBE_AREAS) {
      const parsed = parseResults(file(area), `${area}.jsonl`)
      expect(parsed?.lines.length, area).toBeGreaterThan(0)
      for (const line of parsed?.lines ?? []) {
        expect(line.answer, line.id).toBeNull()
        expect(line.detail, line.id).toBe(NOT_IMPLEMENTED)
        expect(line.data.context.console, line.id).toBe('none')
      }
    }
    expect(() => placeholderLines('context')).toThrow('area must be one of')
  })

  it('gives every check of the catalog a NOT-TESTABLE line, and none reads as missing evidence', () => {
    const summary = summarize({
      results: PROBE_AREAS.map((area) => parseResults(file(area), `${area}.jsonl`)),
      commit: 'a'.repeat(40),
      runId: '1',
      checksHash: 'b'.repeat(64),
      date: '2026-10-29T00:00:00.000Z',
    })
    expect(summary.lines.map((l) => l.id).sort()).toEqual(CHECKS.map((c) => c.id).sort())
    expect(summary.lines.filter((l) => l.status !== 'NOT-TESTABLE')).toEqual([])
    expect(summary.lines.filter((l) => l.detail === NO_RESULT)).toEqual([])
    for (const line of summary.lines.filter((l) => CHECKS.find((c) => c.id === l.id)?.kind === 'check')) {
      expect(line.detail, line.id).toContain(NOT_IMPLEMENTED)
    }
    expect(summary.negativeControl).toBe(false)
  })
})

describe('command-line scripts', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-jobs-'))
    dirs.push(dir)
    return dir
  }
  /**
   * Runs a script with `extra` replacing the test's variables of the same name; an `undefined` entry
   * removes the variable. Names are matched without case, as Windows does: the runner may hold
   * `ImageOS` under another spelling, which an exact `delete` would leave in place.
   */
  const node = (script: string, args: string[], extra: Record<string, string | undefined> = {}) => {
    const replaced = new Set(Object.keys(extra).map((name) => name.toUpperCase()))
    const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !replaced.has(name.toUpperCase())))
    for (const [name, value] of Object.entries(extra)) if (value !== undefined) childEnv[name] = value
    return spawnSync(process.execPath, [join(root, 'scripts/windows-probe', script), ...args], { encoding: 'utf8', env: childEnv })
  }

  it('identity.mjs refuses a missing identity before asking Windows, and writes nothing', () => {
    const out = join(tempDir(), 'results', 'ports.jsonl')
    const run = node('identity.mjs', ['ports', out], { ImageOS: undefined, ImageVersion: undefined, NEGATIVE_CONTROL: 'maybe' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('ImageOS must be set')
    expect(run.stderr).toContain('NEGATIVE_CONTROL must be "true" or "false"')
    expect(existsSync(out)).toBe(false)
    expect(node('identity.mjs', ['nowhere', out], env).stderr).toContain('area must be one of')
    expect(node('identity.mjs', ['ports'], env).status).toBe(2)
    expect(node('identity.mjs', ['ports', out, 'extra'], env).status).toBe(2)
  })

  it('placeholder.mjs appends to the file identity.mjs started, and refuses a missing one', () => {
    const dir = tempDir()
    const out = join(dir, 'ports.jsonl')
    const missing = node('placeholder.mjs', ['ports', out])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('identity.mjs writes its first line')
    expect(existsSync(out)).toBe(false)

    writeFileSync(out, `${identity()}\n`)
    const run = node('placeholder.mjs', ['ports', out])
    expect(run.status, run.stderr).toBe(0)
    const text = readFileSync(out, 'utf8')
    expect(text).toBe(`${identity()}\n${placeholderLines('ports').join('\n')}\n`)
    expect(parseResults(text, 'ports.jsonl')?.lines).toHaveLength(placeholderLines('ports').length)

    expect(node('placeholder.mjs', ['nowhere', out]).status).toBe(1)
    expect(node('placeholder.mjs', ['ports']).status).toBe(2)
  })
})
