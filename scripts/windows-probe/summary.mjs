#!/usr/bin/env node
// Merges the Windows probes' result lines into summary.txt (design D4). The windows-probe workflow's
// `summary` job runs it; the pure functions are exported for test/unit/windows-probe-summary.test.ts.
//
//   node scripts/windows-probe/summary.mjs <results-dir> <summary-file>
//
// reads every `*.jsonl` under <results-dir> (one per probe job), takes the commit and run ID from
// GITHUB_SHA and GITHUB_RUN_ID, writes <summary-file> and prints it. Exit codes: 0 written,
// 1 rejected results, no results file, or failure, 2 usage error. FAIL lines are findings, not errors: they exit 0.
//
// Each results file starts with the job's identity line, then one result line per answered check:
//
//   {"identity":{"area":"ports","imageOS":"win25","imageVersion":"20261020.1.0","windowsBuild":"10.0.26100.6899","node":"v24.11.1","negativeControl":false}}
//   {"id":"port-ps","answer":"yes","detail":"","data":{"context":{"user":"admin","console":"none"}}}
//
// `imageOS` and `imageVersion` are the runner's ImageOS and ImageVersion variables. `data.context` is
// the context the driver was started for (D9); the context controls verify it, so a driver that did
// not get that context makes its area's checks NOT-TESTABLE instead of being rejected. A probe only
// answers (`yes`, `no`, or `null` for no answer); the status comes from the prediction in checks.mjs.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKS, CONTEXT_AREA, PROBE_AREAS, REVISIONS } from './checks.mjs'

export const STATUSES = Object.freeze(['PASS', 'FAIL', 'EXPECTED-FAIL', 'NOT-TESTABLE'])

/** Detail of a check no probe reported (design D4). The evidence test rejects a summary with one. */
export const NO_RESULT = 'no result: probe did not report it'

const USERS = ['admin', 'standard']
const STANDARD_USER = 'ctx-standard-user'
const CONSOLES = ['none', 'present']

/** Thrown for results the summary must not accept; `problems` lists every one found. */
export class ProbeResultError extends Error {
  constructor(problems) {
    super(`rejected probe results:\n${problems.map((p) => `  ${p}`).join('\n')}`)
    this.name = 'ProbeResultError'
    this.problems = problems
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

/** The status of an answer, given the check's prediction (design D3). */
export function deriveStatus(prediction, answer) {
  if (answer === 'yes') return 'PASS'
  if (answer === 'no') return prediction === 'no' ? 'EXPECTED-FAIL' : 'FAIL'
  return 'NOT-TESTABLE'
}

function parseIdentity(value, where, problems) {
  if (!isObject(value)) {
    problems.push(`${where}: the first line must be the job's identity line, {"identity":{…}}`)
    return null
  }
  const before = problems.length
  if (!PROBE_AREAS.includes(value.area)) problems.push(`${where}: identity area must be one of ${PROBE_AREAS.join(', ')}`)
  for (const key of ['imageOS', 'imageVersion', 'windowsBuild', 'node']) {
    if (!nonEmpty(value[key]) || /\s/.test(value[key])) problems.push(`${where}: identity ${key} must be a non-empty string without spaces`)
  }
  if (typeof value.negativeControl !== 'boolean') problems.push(`${where}: identity negativeControl must be true or false`)
  if (problems.length > before) return null
  const { area, imageOS, imageVersion, windowsBuild, node, negativeControl } = value
  return { area, imageOS, imageVersion, windowsBuild, node, negativeControl }
}

function parseResultLine(value, where, problems) {
  const before = problems.length
  if (!isObject(value)) {
    problems.push(`${where}: not a JSON object`)
    return null
  }
  if (!nonEmpty(value.id)) problems.push(`${where}: no check ID`)
  if (!['yes', 'no', null].includes(value.answer)) problems.push(`${where}: answer must be "yes", "no" or null, not ${JSON.stringify(value.answer)}`)
  const detail = value.detail ?? ''
  if (typeof detail !== 'string') problems.push(`${where}: detail must be a string`)
  else if ((value.answer === 'no' || value.answer === null) && detail.trim() === '') problems.push(`${where}: answer ${JSON.stringify(value.answer)} needs a detail giving the reason`)
  const context = isObject(value.data) ? value.data.context : undefined
  if (!isObject(context) || !USERS.includes(context.user) || !CONSOLES.includes(context.console)) {
    problems.push(`${where}: data.context must be {"user":"admin"|"standard","console":"none"|"present"}`)
  }
  if (problems.length > before) return null
  return { id: value.id, answer: value.answer, detail, data: value.data }
}

/**
 * Parses one probe job's results file, as UTF-8 with or without a BOM. `source` names it in error
 * messages. Throws ProbeResultError listing every malformed line, or for a UTF-16 file. An empty file yields null: the job wrote nothing,
 * so its checks are reported as missing.
 */
export function parseResults(text, source) {
  // Windows PowerShell 5.1 writes UTF-16 by default (`>`, `Out-File`) and UTF-8 with a BOM on request.
  if (text.includes('\0')) {
    throw new ProbeResultError([`${source}: contains NUL characters, so it is probably UTF-16; write results as UTF-8`])
  }
  const problems = []
  const rows = text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line, i) => ({ line: line.replace(/\r$/, ''), where: `${source}:${i + 1}` }))
    .filter(({ line }) => line.trim() !== '')
  if (rows.length === 0) return null
  let identity = null
  const lines = []
  for (const [i, { line, where }] of rows.entries()) {
    let value
    try {
      value = JSON.parse(line)
    } catch {
      problems.push(`${where}: not valid JSON`)
      continue
    }
    if (i === 0) {
      identity = parseIdentity(isObject(value) ? value.identity : undefined, where, problems)
    } else if (isObject(value) && 'identity' in value) {
      problems.push(`${where}: only the first line is an identity line`)
    } else {
      const parsed = parseResultLine(value, where, problems)
      if (parsed !== null) lines.push({ ...parsed, where })
    }
  }
  if (problems.length > 0) throw new ProbeResultError(problems)
  return { source, identity, lines }
}

/** Collapses whitespace, so every detail stays on its check's line. */
const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

const SEVERITY = ['FAIL', 'EXPECTED-FAIL', 'NOT-TESTABLE', 'PASS']

/**
 * Builds the summary from parsed results files (`parseResults`). Rejects, with ProbeResultError
 * listing every problem: unknown check IDs, answers to limits, a check reported from another area
 * or account than its own, a check reported twice, and two files for one area.
 */
export function summarize({ results, commit, runId, checksHash, date, checks = CHECKS, revisions = REVISIONS }) {
  const problems = []
  if (!/^[0-9a-f]{40}$/.test(commit)) problems.push(`commit must be a full SHA, not ${JSON.stringify(commit)}`)
  if (!/^\d+$/.test(runId)) problems.push(`run ID must be a number, not ${JSON.stringify(runId)}`)
  if (!/^[0-9a-f]{64}$/.test(checksHash)) problems.push(`checks.mjs hash must be a SHA-256 in hex, not ${JSON.stringify(checksHash)}`)
  if (!nonEmpty(date)) problems.push('date is empty')

  const byId = new Map(checks.map((c) => [c.id, c]))
  const areas = new Map()
  for (const file of results) {
    if (file === null) continue
    const { area } = file.identity
    if (areas.has(area)) problems.push(`${file.source}: area ${area} also reported by ${areas.get(area).source}`)
    else areas.set(area, file)
  }

  // Reports per check ID, and the answers per (area, account) for looking up controls.
  const reports = new Map()
  const answered = new Map()
  const key = (area, user, id) => `${area}\0${user}\0${id}`
  for (const { identity, lines } of areas.values()) {
    for (const line of lines) {
      const entry = byId.get(line.id)
      const { user } = line.data.context
      if (entry === undefined) {
        problems.push(`${line.where}: unknown check ID ${line.id}`)
        continue
      }
      if (entry.kind === 'limit') {
        problems.push(`${line.where}: ${line.id} is a runner limit, which no probe answers`)
        continue
      }
      if (entry.area !== CONTEXT_AREA && entry.area !== identity.area) {
        problems.push(`${line.where}: ${line.id} belongs to area ${entry.area}, not ${identity.area}`)
        continue
      }
      if ((entry.context.user !== 'both' && entry.context.user !== user) || entry.context.console !== line.data.context.console) {
        problems.push(
          `${line.where}: ${line.id} must run as ${entry.context.user} with console ${entry.context.console}, ` +
            `not as ${user} with console ${line.data.context.console}`,
        )
        continue
      }
      const list = reports.get(line.id) ?? []
      const repeated = entry.area !== CONTEXT_AREA ? list[0] : list.find((r) => r.area === identity.area && r.user === user)
      if (repeated !== undefined) {
        problems.push(`${line.where}: ${line.id} already reported at ${repeated.where}`)
        continue
      }
      list.push({ area: identity.area, user, answer: line.answer, detail: line.detail, where: line.where })
      reports.set(line.id, list)
      answered.set(key(identity.area, user, line.id), line.answer)
    }
  }
  if (problems.length > 0) throw new ProbeResultError(problems)

  // An (area, account) whose control did not answer yes is invalid; its dependent checks are NOT-TESTABLE.
  const invalid = new Map()
  const markInvalid = (area, user, reason) => {
    const k = `${area} as ${user}`
    invalid.set(k, [...new Set([...(invalid.get(k) ?? []), reason])])
  }
  const controlFailure = (control, answer) =>
    `control ${control} ${answer === undefined ? 'was not reported' : `answered ${answer === null ? 'nothing' : answer}`}`
  for (const entry of checks) {
    if (entry.kind !== 'check' || !entry.control) continue
    for (const report of reports.get(entry.id) ?? []) {
      if (report.answer !== 'yes') markInvalid(report.area, report.user, controlFailure(entry.id, report.answer))
    }
  }
  // A check run by every driver (`both`) counts as the standard user only if that context was established too.
  const controlsFor = (entry, user) =>
    user === 'standard' && !entry.control && !entry.controls.includes(STANDARD_USER) ? [...entry.controls, STANDARD_USER] : entry.controls
  const failedControl = (area, user, controls) => {
    for (const control of controls) {
      const answer = answered.get(key(area, user, control))
      if (answer === 'yes') continue
      const reason = controlFailure(control, answer)
      markInvalid(area, user, reason)
      return reason
    }
    return null
  }

  const revised = new Set(revisions.map((r) => r.id))
  const lines = []
  for (const entry of checks) {
    if (entry.kind === 'limit') {
      lines.push({ id: entry.id, status: 'NOT-TESTABLE', revised: false, detail: oneLine(entry.reason) })
      continue
    }
    const list = reports.get(entry.id) ?? []
    if (list.length === 0) {
      lines.push({ id: entry.id, status: 'NOT-TESTABLE', revised: revised.has(entry.id), detail: NO_RESULT })
      continue
    }
    const outcomes = list.map((report) => {
      const blocked = failedControl(report.area, report.user, controlsFor(entry, report.user))
      if (blocked !== null) {
        const said = report.answer === 'yes' ? '' : ` (probe: ${oneLine(report.detail)})`
        return { ...report, status: 'NOT-TESTABLE', detail: `${blocked} in ${report.area} as ${report.user}${said}` }
      }
      return { ...report, status: deriveStatus(entry.prediction, report.answer), detail: oneLine(report.detail) }
    })
    const status = SEVERITY.find((s) => outcomes.some((o) => o.status === s))
    // A context check is reported by every driver; its line names each report.
    const detail =
      entry.area === CONTEXT_AREA
        ? outcomes
            .map((o) => `${o.area}/${o.user}: ${o.status}${o.detail === '' ? '' : ` ${o.detail}`}`)
            .sort()
            .join('; ')
        : outcomes[0].detail
    lines.push({ id: entry.id, status, revised: revised.has(entry.id), detail })
  }
  lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // Distinct Windows identities, with the areas measured on each.
  const images = new Map()
  for (const { identity } of areas.values()) {
    const k = [identity.imageOS, identity.imageVersion, identity.windowsBuild, identity.node].join('\0')
    const image = images.get(k) ?? { imageOS: identity.imageOS, imageVersion: identity.imageVersion, windowsBuild: identity.windowsBuild, node: identity.node, areas: [] }
    image.areas.push(identity.area)
    images.set(k, image)
  }
  const sortedImages = [...images.values()]
    .map((image) => ({ ...image, areas: image.areas.sort() }))
    .sort((a, b) => (a.imageVersion < b.imageVersion ? -1 : a.imageVersion > b.imageVersion ? 1 : 0))

  return {
    commit,
    runId,
    date,
    checksHash,
    negativeControl: [...areas.values()].some((file) => file.identity.negativeControl),
    images: sortedImages,
    invalid: [...invalid.entries()].map(([where, reasons]) => ({ where, reasons })).sort((a, b) => (a.where < b.where ? -1 : 1)),
    lines,
  }
}

/**
 * summary.txt: header lines starting with `# ` (commit, run, date, checks.mjs hash, negative-control
 * flag, one `image` line per distinct Windows identity, one `invalid` line per area and account
 * whose control failed), then `<id> <STATUS> [revised] <detail>` per check, sorted by ID.
 */
export function formatSummary(summary) {
  const header = [
    '# windows-probe summary',
    `# commit ${summary.commit}`,
    `# run ${summary.runId}`,
    `# date ${summary.date}`,
    `# checks.mjs sha256:${summary.checksHash}`,
    `# negative-control ${summary.negativeControl}`,
    ...summary.images.map((i) => `# image ${i.imageOS} ${i.imageVersion} build ${i.windowsBuild} node ${i.node}: ${i.areas.join(', ')}`),
    ...summary.invalid.map((i) => `# invalid ${i.where}: ${i.reasons.join('; ')}`),
  ]
  const body = summary.lines.map((l) => [l.id, l.status, ...(l.revised ? ['[revised]'] : []), ...(l.detail === '' ? [] : [l.detail])].join(' '))
  return `${[...header, ...body].join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------

function jsonlFiles(dir) {
  // download-artifact creates no directory when no probe job uploaded anything: that is "no results", not a crash.
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

function main(args) {
  const [resultsDir, out, ...rest] = args
  if (resultsDir === undefined || out === undefined || rest.length > 0) {
    console.error(`usage: summary.mjs <results-dir> <summary-file> (got: ${args.join(' ')})`)
    return 2
  }
  const files = jsonlFiles(resultsDir)
  // No file at all means the results were not downloaded, not that every probe failed to report.
  if (files.length === 0) {
    console.error(`summary.mjs: no .jsonl results under ${resultsDir}`)
    return 1
  }
  const results = files.map((file) => parseResults(readFileSync(file, 'utf8'), relative(resultsDir, file)))
  const summary = summarize({
    results,
    commit: process.env.GITHUB_SHA ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    checksHash: createHash('sha256').update(readFileSync(fileURLToPath(new URL('./checks.mjs', import.meta.url)))).digest('hex'),
    date: new Date().toISOString(),
  })
  const text = formatSummary(summary)
  writeFileSync(out, text)
  process.stdout.write(text)
  return 0
}

/** True when Node runs this file as the entry point. Node resolves symlinks for `import.meta.url`, so argv[1] is too. */
function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`summary.mjs: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
