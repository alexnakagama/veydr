import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CORPUS } from '../../scripts/windows-probe/cmd-corpus.mjs'
import {
  type CatalogEntry,
  type Check,
  catalogProblems,
  CHECKS,
  CMD_ROUTES,
  ENCODING_TOOLS,
  ENCODING_VARIANTS,
  type Revision,
  REVISIONS,
  questionHash,
  revisionProblems,
  snapshotPredictions,
  type SnapshotEntry,
} from '../../scripts/windows-probe/checks.mjs'
import { PACKAGED_ONLY_SMOKE_CHECKS, SMOKE_CHECKS } from '../../scripts/windows-probe/smoke-checks.mjs'
import {
  type Answer,
  deriveStatus,
  formatSummary,
  NO_RESULT,
  parseResults,
  ProbeResultError,
  type ResultsFile,
  summarize,
} from '../../scripts/windows-probe/summary.mjs'

// Design D3 and D4: the check catalog with its fixed predictions, and the summary that derives each
// status from a probe's answer and the prediction.

const root = join(__dirname, '../..')
const snapshot = JSON.parse(readFileSync(join(root, 'test/windows-probe/predictions.json'), 'utf8')) as Record<string, SnapshotEntry>

const ids = (entries: readonly CatalogEntry[]): string[] => entries.map((e) => e.id)
const checksOnly = CHECKS.filter((c): c is Check => c.kind === 'check')

describe('checks.mjs', () => {
  it('is a valid catalog', () => {
    expect(catalogProblems(CHECKS)).toEqual([])
  })

  it('phrases every check as a yes/no question with a reasoned prediction', () => {
    for (const c of checksOnly) {
      expect(c.question.endsWith('?'), c.id).toBe(true)
      expect(['yes', 'no'], c.id).toContain(c.prediction)
      expect(c.reason.trim(), c.id).not.toBe('')
    }
  })

  it('gives every limit a fixed reason, what would verify it, and no prediction', () => {
    const limits = CHECKS.filter((c) => c.kind === 'limit')
    expect(ids(limits).sort()).toEqual(['av-third-party', 'env-desktop-launch', 'l10n-console', 'pt-logoff', 'smartscreen', 'ux-uac-prompt'])
    for (const l of limits) {
      expect(l.reason.trim(), l.id).not.toBe('')
      expect(l.verify.trim(), l.id).not.toBe('')
      expect(l, l.id).not.toHaveProperty('prediction')
    }
  })

  it('includes the context checks, the helper, and the -std variants of design D3', () => {
    const all = ids(CHECKS)
    for (const id of ['ctx-no-console', 'ctx-standard-user', 'ctx-electron-no-console', 'ctx-job', 'helper-csc-build']) expect(all).toContain(id)
    const std = [
      'pt-job-terminate',
      'pt-ctrl-break-attach-node',
      'pt-ctrl-break-attach-npm',
      'pt-ctrl-break-attach-cmd',
      'helper-csc-build',
      'env-registry',
      'port-ps',
      'port-api',
      'port-owner-identity',
    ]
    for (const id of std) expect(all, id).toContain(`${id}-std`)
    for (const c of checksOnly.filter((c) => c.id.endsWith('-std'))) expect(c.context.user, c.id).toBe('standard')
    // Measured as a standard user without the suffix (design D3).
    for (const id of ['port-ps-latency', 'port-api-latency']) expect(checksOnly.find((c) => c.id === id)?.context.user).toBe('standard')
  })

  it('generates the corpus, encoding, and smoke IDs from their sources', () => {
    const all = ids(CHECKS)
    for (const route of Object.keys(CMD_ROUTES)) for (const c of CORPUS) expect(all).toContain(`cmd-route-${route}-${c.id}`)
    for (const tool of Object.keys(ENCODING_TOOLS)) for (const variant of Object.keys(ENCODING_VARIANTS)) expect(all).toContain(`enc-child-${tool}-${variant}`)
    // The installed app is packaged; the built app is not, so it has no line for packaged-only checks.
    for (const name of SMOKE_CHECKS) expect(all).toContain(`nsis-smoke-${name}`)
    expect(all.filter((id) => id.startsWith('electron-smoke-'))).toEqual(
      SMOKE_CHECKS.filter((n) => !PACKAGED_ONLY_SMOKE_CHECKS.includes(n)).map((n) => `electron-smoke-${n}`),
    )
    expect(all.filter((id) => id.startsWith('cmd-route-'))).toHaveLength(Object.keys(CMD_ROUTES).length * CORPUS.length)
    // The unsupported platform makes the smoke test's overall result `fail`; that is predicted (design D3).
    for (const id of ['electron-smoke-platform', 'nsis-smoke-platform']) expect(checksOnly.find((c) => c.id === id)?.prediction).toBe('no')
  })

  it('asks on the verbatim route whether unrepresentable cases are refused, so the route can pass every case', () => {
    const refused = checksOnly.filter((c) => c.id.startsWith('cmd-route-verbatim-') && c.question.includes('refuse')).map((c) => c.id)
    expect(refused).toEqual(['cmd-route-verbatim-newline', 'cmd-route-verbatim-carriage-return', 'cmd-route-verbatim-long'])
    expect(checksOnly.filter((c) => c.id.startsWith('cmd-route-verbatim-')).every((c) => c.prediction === 'yes')).toBe(true)
  })

  it('makes every result depend on the context controls of its account', () => {
    for (const c of checksOnly.filter((c) => c.id !== 'ctx-no-console' && c.id !== 'ctx-standard-user')) {
      expect(c.controls, c.id).toContain('ctx-no-console')
      if (c.context.user === 'standard') expect(c.controls, c.id).toContain('ctx-standard-user')
    }
  })

  it('reports a malformed catalog', () => {
    const base = checksOnly.find((c) => c.id === 'pt-kill-leader') as Check
    const broken: CatalogEntry[] = [
      ...CHECKS,
      { ...base, id: 'pt-kill-leader' },
      { ...base, id: 'Bad_ID', question: 'no question mark', reason: ' ' },
      { ...base, id: 'pt-x-std' },
      { ...base, id: 'pt-y', controls: ['pt-kill-leader'] },
      { ...base, id: 'pt-z', controls: ['pt-control-std'] },
      { ...base, id: 'pt-w', controls: [] },
      { kind: 'limit', id: 'lim', area: 'nsis', reason: 'r', verify: '' },
    ]
    expect(catalogProblems(broken)).toEqual([
      'pt-kill-leader: duplicate ID',
      'Bad_ID: ID is not lower-case words joined by "-"',
      'Bad_ID: no reason',
      'Bad_ID: the question must end with "?"',
      'pt-x-std: a -std check runs as the standard user',
      'pt-y: depends on pt-kill-leader, which is not a control check',
      'pt-y: must depend on ctx-no-console',
      'pt-z: depends on pt-control-std, which runs as standard',
      'pt-z: must depend on ctx-no-console',
      'pt-w: must depend on ctx-no-console',
      'lim: a limit says what would verify it',
    ])
  })
})

describe('predictions snapshot (test/windows-probe/predictions.json)', () => {
  it('matches every prediction and question, except as REVISIONS records', () => {
    expect(revisionProblems(CHECKS, snapshot, REVISIONS)).toEqual([])
  })

  it('holds no limits, and only yes/no predictions with question hashes', () => {
    const limits = new Set(CHECKS.filter((c) => c.kind === 'limit').map((c) => c.id))
    for (const [id, entry] of Object.entries(snapshot)) {
      expect(limits.has(id), id).toBe(false)
      expect(Object.keys(entry).sort(), id).toEqual(['prediction', 'question'])
      expect(['yes', 'no'], id).toContain(entry.prediction)
      expect(entry.question, id).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('was generated from the catalog, sorted by ID', () => {
    const recorded = Object.keys(snapshot)
    expect(recorded).toEqual([...recorded].sort((a, b) => (a < b ? -1 : 1)))
    expect(Object.keys(snapshotPredictions(CHECKS))).toEqual(recorded)
  })

  describe('revisionProblems', () => {
    const catalog = checksOnly.slice(0, 3)
    const [a, b, c] = catalog as [Check, Check, Check]
    const flip = (p: 'yes' | 'no'): 'yes' | 'no' => (p === 'yes' ? 'no' : 'yes')
    const snap = snapshotPredictions(catalog)
    const day = { reason: 'why', date: '2026-11-01' }

    it('fails on a changed prediction without a revision, and passes with one', () => {
      const changed = [{ ...a, prediction: flip(a.prediction) }, b, c]
      expect(revisionProblems(changed, snap, [])).toEqual([
        `${a.id}: predicted ${flip(a.prediction)}, but the snapshot and revisions say ${a.prediction}; record the change in REVISIONS`,
      ])
      expect(revisionProblems(changed, snap, [{ id: a.id, change: 'prediction', from: a.prediction, to: flip(a.prediction), ...day }])).toEqual([])
    })

    it('fails on a reworded question without a revision, and passes with one', () => {
      const reworded = [{ ...a, question: `Not ${a.question}` }, b, c]
      const [from, to] = [questionHash(a.question), questionHash(`Not ${a.question}`)]
      expect(revisionProblems(reworded, snap, [])).toEqual([`${a.id}: question hash ${to} differs from the recorded ${from}; record the change in REVISIONS`])
      expect(revisionProblems(reworded, snap, [{ id: a.id, change: 'question', from, to, ...day }])).toEqual([])
    })

    it('fails on a check added without a revision, and passes when it is marked as added', () => {
      const added = { ...c, id: 'pt-new' }
      expect(revisionProblems([...catalog, added], snap, [])).toEqual(['pt-new: not in the snapshot and no revision marks it as added later'])
      const revision: Revision = { id: 'pt-new', change: 'added', to: added.prediction, question: questionHash(added.question), ...day }
      expect(revisionProblems([...catalog, added], snap, [revision])).toEqual([])
    })

    it('fails on a check removed without a revision, and passes when its removal is recorded', () => {
      expect(revisionProblems([a, b], snap, [])).toEqual([`${c.id}: recorded but no longer a check; record its removal in REVISIONS`])
      expect(revisionProblems([a, b], snap, [{ id: c.id, change: 'removed', from: c.prediction, ...day }])).toEqual([])
    })

    it('fails on a limit or a malformed entry in the snapshot', () => {
      const limitEntry: CatalogEntry = { kind: 'limit', id: 'smartscreen', area: 'nsis', reason: 'r', verify: 'v' }
      expect(revisionProblems([...catalog, limitEntry], { ...snap, smartscreen: { prediction: 'no', question: '0123456789abcdef' } }, [])).toEqual([
        'smartscreen: the snapshot holds a limit, which has no prediction',
      ])
      expect(revisionProblems(catalog, { ...snap, [a.id]: a.prediction }, [])).toEqual([
        `${a.id}: snapshot entry must be {"prediction":"yes"|"no","question":"<16 hex digits>"}`,
        `${a.id}: not in the snapshot and no revision marks it as added later`,
      ])
    })

    it('fails on revisions that do not fit the record', () => {
      const revisions = [
        { id: a.id, change: 'prediction', from: flip(a.prediction), to: a.prediction, reason: 'r', date: '2026-11-01' },
        { id: b.id, change: 'added', to: b.prediction, question: 'x', reason: '', date: 'November' },
        { id: 'nope', change: 'removed', from: 'yes', reason: 'r', date: '2026-11-01' },
        { id: c.id, change: 'question', from: questionHash(c.question), to: questionHash(c.question), reason: 'r', date: '2026-11-01' },
        { id: c.id, change: 'renamed', reason: 'r', date: '2026-11-01' },
      ] as unknown as Revision[]
      expect(revisionProblems(catalog, snap, revisions)).toEqual([
        `revision 1 (${a.id}): changes the prediction from ${flip(a.prediction)}, but it was ${a.prediction}`,
        `revision 2 (${b.id}): no reason`,
        `revision 2 (${b.id}): date must be YYYY-MM-DD`,
        `revision 2 (${b.id}): marked as added, but it is already recorded`,
        `revision 2 (${b.id}): "question" must be a question hash`,
        'revision 3 (nope): removes a check that is not recorded',
        `revision 4 (${c.id}): changes nothing`,
        `revision 5 (${c.id}): change must be "prediction", "question", "added" or "removed"`,
        `${b.id}: question hash ${questionHash(b.question)} differs from the recorded x; record the change in REVISIONS`,
      ])
    })

    it('follows a chain of revisions to the current prediction', () => {
      const there: Revision = { id: a.id, change: 'prediction', from: a.prediction, to: flip(a.prediction), ...day }
      const back: Revision = { id: a.id, change: 'prediction', from: flip(a.prediction), to: a.prediction, ...day }
      expect(revisionProblems(catalog, snap, [there, back])).toEqual([])
      expect(revisionProblems(catalog, snap, [there])).toHaveLength(1)
      expect(revisionProblems(catalog, snap, [{ ...there, to: a.prediction }])).toEqual([`revision 1 (${a.id}): changes nothing`])
    })
  })
})

// ---------------------------------------------------------------------------------------------
// summary.mjs, against a small catalog of its own.

const ctl = (id: string, area: Check['area'], user: 'admin' | 'standard' | 'both', controls: string[] = []): Check => ({
  kind: 'check',
  id,
  area,
  question: `${id}?`,
  prediction: 'yes',
  reason: 'r',
  feeds: ['t'],
  context: { console: 'none', user },
  controls,
  control: true,
})
const chk = (id: string, prediction: 'yes' | 'no', controls: string[], user: 'admin' | 'standard' | 'both' = 'admin', area: Check['area'] = 'ports'): Check => ({
  kind: 'check',
  id,
  area,
  question: `${id}?`,
  prediction,
  reason: 'r',
  feeds: ['t'],
  context: { console: 'none', user },
  controls,
  control: false,
})

const catalog: CatalogEntry[] = [
  ctl('ctx-no-console', 'context', 'both'),
  ctl('ctx-standard-user', 'context', 'standard'),
  chk('ctx-job', 'no', ['ctx-no-console'], 'both', 'context'),
  ctl('port-control', 'ports', 'admin', ['ctx-no-console']),
  chk('port-a', 'yes', ['ctx-no-console', 'port-control']),
  chk('port-b', 'no', ['ctx-no-console', 'port-control']),
  chk('port-c-std', 'yes', ['ctx-no-console', 'ctx-standard-user'], 'standard'),
  chk('enc-x', 'yes', ['ctx-no-console'], 'admin', 'encoding'),
  { kind: 'limit', id: 'smartscreen', area: 'nsis', reason: 'no desktop', verify: 'a desktop' },
]

const SHA = 'a'.repeat(40)
const HASH = 'b'.repeat(64)

interface Line {
  id: string
  answer: Answer
  detail?: string
  user?: 'admin' | 'standard'
  console?: 'none' | 'present'
}

function identity(area: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ identity: { area, imageOS: 'win25', imageVersion: '20261020.1.0', windowsBuild: '10.0.26100.6899', node: 'v24.11.1', negativeControl: false, ...overrides } })
}

function file(area: string, lines: Line[], identityOverrides: Record<string, unknown> = {}): string {
  const rows = lines.map(({ id, answer, detail, user = 'admin', console = 'none' }) =>
    JSON.stringify({ id, answer, ...(detail === undefined ? {} : { detail }), data: { context: { user, console } } }),
  )
  return [identity(area, identityOverrides), ...rows].join('\n') + '\n'
}

const parse = (area: string, lines: Line[], overrides: Record<string, unknown> = {}): ResultsFile => {
  const parsed = parseResults(file(area, lines, overrides), `${area}.jsonl`)
  if (parsed === null) throw new Error('empty')
  return parsed
}

const run = (results: (ResultsFile | null)[], revisions: Revision[] = []) =>
  summarize({ results, commit: SHA, runId: '123', checksHash: HASH, date: '2026-11-01T10:00:00.000Z', checks: catalog, revisions })

const statusOf = (summary: ReturnType<typeof run>, id: string) => summary.lines.find((l) => l.id === id)

function rejection(fn: () => unknown): string[] {
  try {
    fn()
  } catch (error) {
    if (error instanceof ProbeResultError) return [...error.problems]
    throw error
  }
  throw new Error('not rejected')
}

const portsOk: Line[] = [
  { id: 'ctx-no-console', answer: 'yes' },
  { id: 'ctx-job', answer: 'no', detail: 'in job 0x1' },
  { id: 'port-control', answer: 'yes' },
]

describe('deriveStatus', () => {
  it.each([
    ['yes', 'yes', 'PASS'],
    ['no', 'yes', 'PASS'],
    ['yes', 'no', 'FAIL'],
    ['no', 'no', 'EXPECTED-FAIL'],
    ['yes', null, 'NOT-TESTABLE'],
    ['no', null, 'NOT-TESTABLE'],
  ] as const)('prediction %s, answer %s: %s', (prediction, answer, status) => {
    expect(deriveStatus(prediction, answer)).toBe(status)
  })
})

describe('parseResults', () => {
  it('parses the identity line and the result lines, with CRLF tolerated', () => {
    const parsed = parseResults(file('ports', [{ id: 'port-a', answer: 'yes' }, { id: 'port-b', answer: 'no', detail: 'missing ::1' }]).replace(/\n/g, '\r\n'), 'ports.jsonl')
    expect(parsed?.identity).toEqual({ area: 'ports', imageOS: 'win25', imageVersion: '20261020.1.0', windowsBuild: '10.0.26100.6899', node: 'v24.11.1', negativeControl: false })
    expect(parsed?.lines.map((l) => [l.id, l.answer, l.detail, l.where])).toEqual([
      ['port-a', 'yes', '', 'ports.jsonl:2'],
      ['port-b', 'no', 'missing ::1', 'ports.jsonl:3'],
    ])
  })

  it('accepts a UTF-8 BOM and rejects UTF-16, which Windows PowerShell 5.1 writes by default', () => {
    expect(parseResults(`\uFEFF${file('ports', [{ id: 'port-a', answer: 'yes' }])}`, 'p.jsonl')?.lines).toHaveLength(1)
    const utf16 = Buffer.from(`\uFEFF${file('ports', [])}`, 'utf16le').toString('utf8')
    expect(rejection(() => parseResults(utf16, 'p.jsonl'))).toEqual(['p.jsonl: contains NUL characters, so it is probably UTF-16; write results as UTF-8'])
  })

  it('returns null for an empty file', () => {
    expect(parseResults('\n\n', 'x.jsonl')).toBeNull()
  })

  it('rejects malformed lines, listing every problem', () => {
    const text = [
      identity('ports', { imageVersion: '', negativeControl: 'no' }),
      '{not json',
      JSON.stringify({ id: 'port-a', answer: 'maybe', data: { context: { user: 'admin', console: 'none' } } }),
      JSON.stringify({ id: 'port-b', answer: 'no', detail: ' ', data: { context: { user: 'admin', console: 'none' } } }),
      JSON.stringify({ id: 'port-a', answer: null, data: { context: { user: 'admin', console: 'none' } } }),
      JSON.stringify({ id: 'port-a', answer: 'yes', data: { context: { user: 'root', console: 'none' } } }),
      JSON.stringify({ id: 'port-a', answer: 'yes' }),
      identity('ports'),
    ].join('\n')
    expect(rejection(() => parseResults(text, 'p.jsonl'))).toEqual([
      'p.jsonl:1: identity imageVersion must be a non-empty string without spaces',
      'p.jsonl:1: identity negativeControl must be true or false',
      'p.jsonl:2: not valid JSON',
      'p.jsonl:3: answer must be "yes", "no" or null, not "maybe"',
      'p.jsonl:4: answer "no" needs a detail giving the reason',
      'p.jsonl:5: answer null needs a detail giving the reason',
      'p.jsonl:6: data.context must be {"user":"admin"|"standard","console":"none"|"present"}',
      'p.jsonl:7: data.context must be {"user":"admin"|"standard","console":"none"|"present"}',
      'p.jsonl:8: only the first line is an identity line',
    ])
  })

  it('rejects a file whose first line is not an identity line', () => {
    expect(rejection(() => parseResults(JSON.stringify({ id: 'port-a', answer: 'yes' }), 'p.jsonl'))).toEqual([
      'p.jsonl:1: the first line must be the job\'s identity line, {"identity":{…}}',
    ])
    expect(rejection(() => parseResults('null', 'p.jsonl'))).toEqual(['p.jsonl:1: the first line must be the job\'s identity line, {"identity":{…}}'])
    expect(rejection(() => parseResults(identity('kitchen'), 'p.jsonl'))).toEqual([
      'p.jsonl:1: identity area must be one of process-tree, helper, commands, environment, encoding, ports, electron, nsis',
    ])
  })
})

describe('summarize', () => {
  it('derives each status from the answer and the prediction', () => {
    const s = run([
      parse('ports', [
        ...portsOk,
        { id: 'port-a', answer: 'no', detail: 'listener on ::1 missing' },
        { id: 'port-b', answer: 'no', detail: 'as predicted' },
        { id: 'port-c-std', answer: null, detail: 'no answer', user: 'standard' },
        { id: 'ctx-no-console', answer: 'yes', user: 'standard' },
        { id: 'ctx-standard-user', answer: 'yes', user: 'standard' },
      ]),
      parse('encoding', [{ id: 'ctx-no-console', answer: 'yes' }, { id: 'enc-x', answer: 'yes', detail: 'bytes 47 72' }]),
    ])
    expect(s.lines.map((l) => [l.id, l.status, l.detail])).toEqual([
      ['ctx-job', 'EXPECTED-FAIL', 'ports/admin: EXPECTED-FAIL in job 0x1'],
      ['ctx-no-console', 'PASS', 'encoding/admin: PASS; ports/admin: PASS; ports/standard: PASS'],
      ['ctx-standard-user', 'PASS', 'ports/standard: PASS'],
      ['enc-x', 'PASS', 'bytes 47 72'],
      ['port-a', 'FAIL', 'listener on ::1 missing'],
      ['port-b', 'EXPECTED-FAIL', 'as predicted'],
      ['port-c-std', 'NOT-TESTABLE', 'no answer'],
      ['port-control', 'PASS', ''],
      ['smartscreen', 'NOT-TESTABLE', 'no desktop'],
    ])
    expect(s.invalid).toEqual([])
  })

  it('reports a check no probe answered as missing evidence', () => {
    const s = run([parse('ports', portsOk), null])
    expect(statusOf(s, 'port-a')).toEqual({ id: 'port-a', status: 'NOT-TESTABLE', revised: false, detail: NO_RESULT })
    expect(statusOf(s, 'enc-x')?.detail).toBe(NO_RESULT)
    expect(statusOf(s, 'ctx-standard-user')?.detail).toBe(NO_RESULT)
  })

  it('turns the checks of an area whose context control failed into NOT-TESTABLE, naming the control', () => {
    const s = run([
      parse('ports', [
        { id: 'ctx-no-console', answer: 'no', detail: 'GetConsoleWindow returned 0x2a' },
        { id: 'port-control', answer: 'yes' },
        { id: 'port-a', answer: 'yes' },
        { id: 'port-b', answer: 'no', detail: 'as predicted' },
      ]),
      parse('encoding', [{ id: 'ctx-no-console', answer: 'yes' }, { id: 'enc-x', answer: 'yes' }], { negativeControl: true }),
    ])
    expect(statusOf(s, 'ctx-no-console')?.status).toBe('FAIL')
    expect(statusOf(s, 'port-control')).toMatchObject({ status: 'NOT-TESTABLE', detail: 'control ctx-no-console answered no in ports as admin' })
    expect(statusOf(s, 'port-a')).toMatchObject({ status: 'NOT-TESTABLE', detail: 'control ctx-no-console answered no in ports as admin' })
    expect(statusOf(s, 'port-b')).toMatchObject({ status: 'NOT-TESTABLE', detail: 'control ctx-no-console answered no in ports as admin (probe: as predicted)' })
    // Other areas are unaffected.
    expect(statusOf(s, 'enc-x')?.status).toBe('PASS')
    expect(s.invalid).toEqual([{ where: 'ports as admin', reasons: ['control ctx-no-console answered no'] }])
    expect(s.negativeControl).toBe(true)
  })

  it('treats a missing context control as failed, per account', () => {
    const s = run([
      parse('ports', [
        ...portsOk,
        { id: 'port-a', answer: 'yes' },
        { id: 'ctx-no-console', answer: 'yes', user: 'standard' },
        { id: 'port-c-std', answer: 'yes', user: 'standard' },
      ]),
    ])
    expect(statusOf(s, 'port-a')?.status).toBe('PASS')
    expect(statusOf(s, 'port-c-std')).toMatchObject({ status: 'NOT-TESTABLE', detail: 'control ctx-standard-user was not reported in ports as standard' })
    expect(s.invalid).toEqual([{ where: 'ports as standard', reasons: ['control ctx-standard-user was not reported'] }])
  })

  it('counts a check run by every driver as the standard user only when that context was established', () => {
    const s = run([
      parse('ports', [
        ...portsOk,
        { id: 'ctx-no-console', answer: 'yes', user: 'standard' },
        { id: 'ctx-standard-user', answer: 'no', detail: 'token is elevated', user: 'standard' },
        { id: 'ctx-job', answer: 'no', detail: 'in job 0x2', user: 'standard' },
      ]),
    ])
    expect(statusOf(s, 'ctx-job')?.detail).toBe(
      'ports/admin: EXPECTED-FAIL in job 0x1; ports/standard: NOT-TESTABLE control ctx-standard-user answered no in ports as standard (probe: in job 0x2)',
    )
    expect(statusOf(s, 'ctx-standard-user')?.status).toBe('FAIL')
  })

  it('marks an area invalid when its own control failed', () => {
    const s = run([
      parse('ports', [
        { id: 'ctx-no-console', answer: 'yes' },
        { id: 'port-control', answer: null, detail: 'helper did not start' },
        { id: 'port-a', answer: 'yes' },
      ]),
    ])
    expect(statusOf(s, 'port-control')).toMatchObject({ status: 'NOT-TESTABLE', detail: 'helper did not start' })
    expect(statusOf(s, 'port-a')).toMatchObject({ status: 'NOT-TESTABLE', detail: 'control port-control answered nothing in ports as admin' })
    expect(s.invalid).toEqual([{ where: 'ports as admin', reasons: ['control port-control answered nothing'] }])
  })

  it('rejects unknown IDs, answered limits, wrong areas and contexts, and repeats', () => {
    const problems = rejection(() =>
      run([
        parse('ports', [
          ...portsOk,
          { id: 'port-zzz', answer: 'yes' },
          { id: 'smartscreen', answer: null, detail: 'x' },
          { id: 'enc-x', answer: 'yes' },
          { id: 'port-a', answer: 'yes', user: 'standard' },
          { id: 'port-b', answer: 'yes', console: 'present' },
          { id: 'port-control', answer: 'yes' },
          { id: 'ctx-no-console', answer: 'yes' },
        ]),
        parse('ports', [{ id: 'port-a', answer: 'yes' }]),
      ]),
    )
    expect(problems).toEqual([
      'ports.jsonl: area ports also reported by ports.jsonl',
      'ports.jsonl:5: unknown check ID port-zzz',
      'ports.jsonl:6: smartscreen is a runner limit, which no probe answers',
      'ports.jsonl:7: enc-x belongs to area encoding, not ports',
      'ports.jsonl:8: port-a must run as admin with console none, not as standard with console none',
      'ports.jsonl:9: port-b must run as admin with console none, not as admin with console present',
      'ports.jsonl:10: port-control already reported at ports.jsonl:4',
      'ports.jsonl:11: ctx-no-console already reported at ports.jsonl:2',
    ])
  })

  it('rejects an invalid run identity', () => {
    expect(rejection(() => summarize({ results: [], commit: 'abc', runId: 'x', checksHash: 'nope', date: '', checks: catalog }))).toEqual([
      'commit must be a full SHA, not "abc"',
      'run ID must be a number, not "x"',
      'checks.mjs hash must be a SHA-256 in hex, not "nope"',
      'date is empty',
    ])
  })

  it('takes the Windows identity only from the identity lines, listing each image with its areas', () => {
    const one = run([parse('ports', portsOk), parse('encoding', [{ id: 'ctx-no-console', answer: 'yes' }])])
    expect(one.images).toEqual([{ imageOS: 'win25', imageVersion: '20261020.1.0', windowsBuild: '10.0.26100.6899', node: 'v24.11.1', areas: ['encoding', 'ports'] }])

    const two = run([
      parse('ports', portsOk, { imageVersion: '20261027.2.0', windowsBuild: '10.0.26100.7000' }),
      parse('encoding', [{ id: 'ctx-no-console', answer: 'yes' }]),
      parse('nsis', [{ id: 'ctx-no-console', answer: 'yes' }]),
    ])
    expect(two.images.map((i) => [i.imageVersion, i.windowsBuild, i.areas])).toEqual([
      ['20261020.1.0', '10.0.26100.6899', ['encoding', 'nsis']],
      ['20261027.2.0', '10.0.26100.7000', ['ports']],
    ])
    expect(two.negativeControl).toBe(false)
  })

  it('prints a check with a revisions entry as revised', () => {
    const revisions: Revision[] = [{ id: 'port-b', change: 'prediction', from: 'yes', to: 'no', reason: 'r', date: '2026-11-01' }]
    const s = run([parse('ports', [...portsOk, { id: 'port-b', answer: 'no', detail: 'as predicted' }])], revisions)
    expect(statusOf(s, 'port-b')).toEqual({ id: 'port-b', status: 'EXPECTED-FAIL', revised: true, detail: 'as predicted' })
    expect(formatSummary(s)).toContain('\nport-b EXPECTED-FAIL [revised] as predicted\n')
  })
})

describe('formatSummary', () => {
  it('writes the header, then one line per check sorted by ID, each detail on one line', () => {
    const s = run([
      parse('ports', [
        { id: 'ctx-no-console', answer: 'yes' },
        { id: 'port-control', answer: 'no', detail: 'no socket\nfound' },
        { id: 'port-a', answer: 'yes' },
      ]),
    ])
    expect(formatSummary(s)).toBe(
      [
        '# windows-probe summary',
        `# commit ${SHA}`,
        '# run 123',
        '# date 2026-11-01T10:00:00.000Z',
        `# checks.mjs sha256:${HASH}`,
        '# negative-control false',
        '# image win25 20261020.1.0 build 10.0.26100.6899 node v24.11.1: ports',
        '# invalid ports as admin: control port-control answered no',
        `ctx-job NOT-TESTABLE ${NO_RESULT}`,
        'ctx-no-console PASS ports/admin: PASS',
        `ctx-standard-user NOT-TESTABLE ${NO_RESULT}`,
        `enc-x NOT-TESTABLE ${NO_RESULT}`,
        'port-a NOT-TESTABLE control port-control answered no in ports as admin',
        `port-b NOT-TESTABLE ${NO_RESULT}`,
        `port-c-std NOT-TESTABLE ${NO_RESULT}`,
        'port-control FAIL no socket found',
        'smartscreen NOT-TESTABLE no desktop',
        '',
      ].join('\n'),
    )
  })

  it('lists every catalog entry exactly once for the real catalog', () => {
    const s = summarize({ results: [], commit: SHA, runId: '1', checksHash: HASH, date: '2026-11-01T10:00:00.000Z' })
    expect(s.lines.map((l) => l.id)).toEqual(ids(CHECKS).sort((a, b) => (a < b ? -1 : 1)))
    expect(new Set(s.lines.map((l) => l.status))).toEqual(new Set(['NOT-TESTABLE']))
    const body = formatSummary(s).split('\n').filter((l) => l !== '' && !l.startsWith('# '))
    expect(body).toHaveLength(CHECKS.length)
  })
})

describe('command-line scripts', () => {
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const node = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(root, 'scripts/windows-probe', script), ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: '', GITHUB_RUN_ID: '', ...env },
    })

  it('checks.mjs writes the snapshot once and refuses to overwrite it', () => {
    const out = join(tempDir(), 'predictions.json')
    const first = node('checks.mjs', ['snapshot', out])
    expect(first.status, first.stderr).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(snapshotPredictions(CHECKS))
    writeFileSync(out, '{}\n')
    const second = node('checks.mjs', ['snapshot', out])
    expect(second.status).toBe(1)
    expect(second.stderr).toContain('exists; the snapshot is never regenerated')
    expect(readFileSync(out, 'utf8')).toBe('{}\n')
    expect(node('checks.mjs', ['snapshot']).status).toBe(2)
  })

  it('summary.mjs writes summary.txt from the results under a directory', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'results', 'ports-artifact'), { recursive: true })
    writeFileSync(
      join(dir, 'results', 'ports-artifact', 'ports.jsonl'),
      `\uFEFF${file('ports', [{ id: 'ctx-no-console', answer: 'yes' }, { id: 'port-control', answer: 'yes' }, { id: 'port-netstat', answer: 'no', detail: '::1 missing' }])}`,
    )
    const out = join(dir, 'summary.txt')
    const result = node('summary.mjs', [join(dir, 'results'), out], { GITHUB_SHA: SHA, GITHUB_RUN_ID: '42' })
    expect(result.status, result.stderr).toBe(0)
    const text = readFileSync(out, 'utf8')
    expect(result.stdout).toBe(text)
    expect(text).toContain(`# commit ${SHA}\n# run 42\n`)
    expect(text).toMatch(/\n# checks\.mjs sha256:[0-9a-f]{64}\n/)
    expect(text).toContain('\nport-netstat FAIL ::1 missing\n')
    expect(text.split('\n').filter((l) => l !== '' && !l.startsWith('# '))).toHaveLength(CHECKS.length)
  })

  it('summary.mjs fails without results files, with rejected results, and on misuse', () => {
    const empty = tempDir()
    const env = { GITHUB_SHA: SHA, GITHUB_RUN_ID: '42' }
    const none = node('summary.mjs', [empty, join(empty, 'summary.txt')], env)
    expect(none.status).toBe(1)
    expect(none.stderr).toContain('no .jsonl results under')
    expect(existsSync(join(empty, 'summary.txt'))).toBe(false)
    // No probe job uploaded anything, so download-artifact created no directory.
    const absent = node('summary.mjs', [join(empty, 'absent'), join(empty, 'summary.txt')], env)
    expect(absent.status).toBe(1)
    expect(absent.stderr).toContain('no .jsonl results under')
    expect(existsSync(join(empty, 'summary.txt'))).toBe(false)

    writeFileSync(join(empty, 'ports.jsonl'), file('ports', [{ id: 'port-zzz', answer: 'yes' }]))
    const rejected = node('summary.mjs', [empty, join(empty, 'summary.txt')], env)
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('unknown check ID port-zzz')
    expect(existsSync(join(empty, 'summary.txt'))).toBe(false)

    expect(node('summary.mjs', [empty]).status).toBe(2)
  })
})
