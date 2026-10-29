#!/usr/bin/env node
// Stands in for a probe area not implemented yet (tasks 2.3; groups 3–7 replace it area by area).
// It answers nothing: every check the area's drivers will report gets an answer of null, so the
// summary lists each as NOT-TESTABLE with the reason instead of as missing evidence.
//
//   node scripts/windows-probe/placeholder.mjs <area> <results-file>
//
// appends the lines to <results-file>, which identity.mjs must have started. Exit codes: 0 written,
// 1 failure, 2 usage error.
import { appendFileSync, existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHECKS, CONTEXT_AREA, PROBE_AREAS } from './checks.mjs'

export const NOT_IMPLEMENTED = 'probe not implemented yet'

/**
 * The result lines of a placeholder for `area`, without line breaks: one per check of the area, in
 * the account it runs as, and one per context check for each account the area's drivers run as.
 */
export function placeholderLines(area, checks = CHECKS) {
  if (!PROBE_AREAS.includes(area)) throw new Error(`area must be one of ${PROBE_AREAS.join(', ')}, not ${JSON.stringify(area)}`)
  const own = checks.filter((c) => c.kind === 'check' && c.area === area)
  const accounts = (c) => (c.context.user === 'both' ? ['admin', 'standard'] : [c.context.user])
  const users = ['admin', 'standard'].filter((user) => own.some((c) => accounts(c).includes(user)))
  const line = (id, user) => JSON.stringify({ id, answer: null, detail: NOT_IMPLEMENTED, data: { context: { user, console: 'none' }, placeholder: true } })
  const context = checks.filter((c) => c.kind === 'check' && c.area === CONTEXT_AREA)
  return [
    ...users.flatMap((user) => context.filter((c) => accounts(c).includes(user)).map((c) => line(c.id, user))),
    ...own.flatMap((c) => accounts(c).filter((user) => users.includes(user)).map((user) => line(c.id, user))),
  ]
}

function main(args) {
  const [area, out, ...rest] = args
  if (area === undefined || out === undefined || rest.length > 0) {
    console.error(`usage: placeholder.mjs <area> <results-file> (got: ${args.join(' ')})`)
    return 2
  }
  if (!existsSync(out)) throw new Error(`${out} does not exist; identity.mjs writes its first line`)
  const lines = placeholderLines(area)
  appendFileSync(out, lines.map((l) => `${l}\n`).join(''))
  console.log(`${area}: ${lines.length} checks reported as not implemented yet`)
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
    console.error(`placeholder.mjs: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
