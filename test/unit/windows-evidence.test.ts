import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Check, CHECKS, CONTEXT_AREA, PROBE_AREAS, REVISIONS } from '../../scripts/windows-probe/checks.mjs'
import { formatSummary, NO_RESULT, parseResults, type Status, STATUSES, summarize } from '../../scripts/windows-probe/summary.mjs'

// assess-windows-platform design D4 and D7: the committed Windows probe evidence, and
// docs/windows-evidence.md, which explains it, must agree with each other and with checks.mjs.

const root = join(__dirname, '../..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')
const summaryText = read('test/windows-probe/summary.txt')
const resultsDir = join(root, 'test/windows-probe/results')
const doc = read('docs/windows-evidence.md')

const headerLines = summaryText.split('\n').filter((line) => line.startsWith('# '))
const header = (key: string): string[] => headerLines.filter((line) => line.startsWith(`# ${key} `)).map((line) => line.slice(key.length + 3))

interface Line {
  readonly id: string
  readonly status: string
  readonly revised: boolean
  readonly detail: string
}
const lines: Line[] = summaryText
  .split('\n')
  .filter((line) => line !== '' && !line.startsWith('# '))
  .map((line) => {
    const [id = '', status = '', ...rest] = line.split(' ')
    const revised = rest[0] === '[revised]'
    return { id, status, revised, detail: (revised ? rest.slice(1) : rest).join(' ') }
  })
const statusOf = new Map(lines.map((l) => [l.id, l.status]))
const checks = CHECKS.filter((c): c is Check => c.kind === 'check')
const limits = CHECKS.filter((c) => c.kind === 'limit')

/** A `## ` section of the doc, without its heading. */
function section(title: string): string {
  const part = doc.split('\n## ').find((p) => p.startsWith(`${title}\n`))
  if (part === undefined) throw new Error(`docs/windows-evidence.md has no "## ${title}" section`)
  return part.slice(title.length + 1)
}

/**
 * Check IDs a text cites in backticks; `*` stands for any part of an ID. A hyphenated token that starts
 * like a check ID but matches none is reported as unknown, so a mistyped ID cannot pass as a citation.
 */
const ID_PREFIXES = new Set(CHECKS.map((c) => c.id.split('-')[0]))
function citedIds(text: string): { cited: string[]; unknown: string[] } {
  const cited = new Set<string>()
  const unknown: string[] = []
  for (const [, token = ''] of text.matchAll(/`([a-z0-9*]+(?:-[a-z0-9*]+)*)`/g)) {
    if (!token.includes('-')) {
      if (CHECKS.some((c) => c.id === token)) cited.add(token)
      continue
    }
    if (!ID_PREFIXES.has(token.split('-')[0] ?? '')) continue
    const pattern = new RegExp(`^${token.replace(/\*/g, '[a-z0-9-]+')}$`)
    const matches = CHECKS.filter((c) => pattern.test(c.id)).map((c) => c.id)
    if (matches.length === 0) unknown.push(token)
    for (const id of matches) cited.add(id)
  }
  return { cited: [...cited], unknown }
}

describe('test/windows-probe/summary.txt', () => {
  it('is what summary.mjs makes of the committed results, one file per probe area', () => {
    const files = readdirSync(resultsDir).sort()
    expect(files).toEqual(PROBE_AREAS.map((area) => `${area}.jsonl`).sort())
    const results = files.map((file) => parseResults(readFileSync(join(resultsDir, file), 'utf8'), file))
    for (const [i, file] of files.entries()) expect(results[i]?.identity.area, file).toBe(file.replace(/\.jsonl$/, ''))
    const [commit = '', runId = '', date = ''] = [header('commit')[0], header('run')[0], header('date')[0]]
    const checksHash = (header('checks.mjs')[0] ?? '').replace(/^sha256:/, '')
    expect(formatSummary(summarize({ results, commit, runId, checksHash, date }))).toBe(summaryText)
  })

  it('has exactly one line per check ID in checks.mjs, with a valid status and a reason where one is required', () => {
    expect(lines.map((l) => l.id)).toEqual(CHECKS.map((c) => c.id).sort())
    const revised = new Set(REVISIONS.map((r) => r.id))
    for (const l of lines) {
      expect(STATUSES, l.id).toContain(l.status)
      if (l.status !== 'PASS') expect(l.detail.trim(), `${l.id} needs a reason`).not.toBe('')
      expect(l.revised, `${l.id} [revised]`).toBe(revised.has(l.id))
    }
  })

  it('comes from one normal run on one Windows image', () => {
    expect(headerLines[0]).toBe('# windows-probe summary')
    expect(header('commit')).toEqual([expect.stringMatching(/^[0-9a-f]{40}$/)])
    expect(header('run')).toEqual([expect.stringMatching(/^\d+$/)])
    expect(header('date')).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/)])
    expect(header('checks.mjs')).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{64}$/)])
    expect(header('negative-control')).toEqual(['false'])
    const images = header('image')
    expect(images, 'a summary with several image versions needs a rerun').toHaveLength(1)
    expect(images[0]).toMatch(new RegExp(`^\\S+ \\S+ build \\S+ node \\S+: ${[...PROBE_AREAS].sort().join(', ')}$`))
  })

  it('has a result for every check', () => {
    expect(lines.filter((l) => l.detail === NO_RESULT).map((l) => l.id)).toEqual([])
  })

  it('records nothing from a context its controls did not establish', () => {
    // Every driver reports the context checks, so their line names each report as `<area>/<user>: <STATUS>`.
    const reports = (check: Check): { area: string; user: string; status: string }[] => {
      if (check.area !== CONTEXT_AREA) return [{ area: check.area, user: check.context.user, status: statusOf.get(check.id) ?? '' }]
      const detail = lines.find((l) => l.id === check.id)?.detail ?? ''
      return [...detail.matchAll(/(?:^|; )([a-z-]+)\/(admin|standard): ([A-Z-]+)/g)].map(([, area = '', user = '', status = '']) => ({ area, user, status }))
    }
    for (const id of ['ctx-no-console', 'ctx-standard-user']) {
      const check = checks.find((c) => c.id === id)
      expect(check === undefined ? [] : reports(check), `${id} names its reports`).not.toEqual([])
    }
    for (const control of checks.filter((c) => c.control)) {
      for (const { area, user } of reports(control).filter((r) => r.status !== 'PASS')) {
        const dependents = checks.filter(
          (c) => !c.control && (c.controls.includes(control.id) || (control.id === 'ctx-standard-user' && c.context.user === 'standard')),
        )
        for (const c of dependents) {
          for (const r of reports(c).filter((r) => r.area === area && r.user === user)) {
            expect(r.status, `${c.id} in ${area} as ${user}: ${control.id} did not pass`).toBe('NOT-TESTABLE')
          }
        }
      }
    }
  })
})

describe('docs/windows-evidence.md', () => {
  it('names the recorded run, its image, and the predictions snapshot with every revision', () => {
    expect(doc).toContain(header('commit')[0])
    expect(doc).toContain(`actions/runs/${header('run')[0]}`)
    const imageVersion = (header('image')[0] ?? '').split(' ')[1] ?? ''
    expect(imageVersion).not.toBe('')
    expect(doc).toContain(imageVersion)
    const predictions = section('Predictions')
    expect(predictions).toContain('test/windows-probe/predictions.json')
    expect(predictions).toMatch(/\b[0-9a-f]{40}\b/)
    if (REVISIONS.length === 0) expect(predictions).toContain('`REVISIONS` is empty')
    for (const r of REVISIONS) expect(predictions, r.id).toContain(`\`${r.id}\``)
  })

  it('lists every check that did not pass, and every prediction that did not hold', () => {
    const { cited } = citedIds(doc)
    const notPassed = lines.filter((l) => l.status !== 'PASS').map((l) => l.id)
    const surprises = checks.filter((c) => c.prediction === 'no' && statusOf.get(c.id) === 'PASS').map((c) => c.id)
    for (const id of [...notPassed, ...surprises]) expect(cited, id).toContain(id)
    const failed = (status: Status): string[] => lines.filter((l) => l.status === status).map((l) => l.id)
    const verified = citedIds(section('Verified on the runner')).cited
    for (const id of [...failed('FAIL'), ...surprises]) expect(verified, `${id} under "Verified on the runner"`).toContain(id)
  })

  it('lists every runner limit, and every other check without an answer, as not verifiable, with what would verify it', () => {
    const notVerifiable = section('Not verifiable on the runner')
    const { cited } = citedIds(notVerifiable)
    for (const id of lines.filter((l) => l.status === 'NOT-TESTABLE').map((l) => l.id)) expect(cited, id).toContain(id)
    for (const limit of limits) expect(notVerifiable, limit.id).toContain(limit.verify)
  })

  it('cites only recorded check IDs, and every decision cites at least one', () => {
    expect(citedIds(doc).unknown).toEqual([])
    const decisions = section('Decisions').split('\n### ').slice(1)
    expect(decisions.map((d) => d.split('\n')[0])).toEqual([
      'Process trees (W1, G-4)',
      'Graceful stop (W1)',
      'Crash recovery (W1)',
      'Shell mode (W2)',
      'Ports (W3)',
      'Electron in Windows CI (W1–W4)',
    ])
    for (const decision of decisions) {
      const title = decision.split('\n')[0] ?? ''
      const { cited } = citedIds(decision)
      expect(cited.length, `"${title}" cites no check ID`).toBeGreaterThan(0)
      for (const id of cited) expect(statusOf.has(id), `${title}: ${id}`).toBe(true)
    }
  })

  it('is linked from docs/deferred-checks.md', () => {
    expect(read('docs/deferred-checks.md')).toContain('(windows-evidence.md#not-verifiable-on-the-runner)')
    expect(doc).toContain('\n## Not verifiable on the runner\n')
  })
})
