#!/usr/bin/env node
// The driver of a probe area not implemented yet (tasks 2.3; groups 4–7 replace it area by area).
// It runs like every driver (driver.mjs): started by launch-detached.mjs without a console, it
// reports the context checks first, measured for real, and then answers each of the area's checks
// for its account with null and the reason, so the summary lists them as NOT-TESTABLE instead of as
// missing evidence.
//
//   node scripts/windows-probe/placeholder.mjs <area> --user admin|standard [--unavailable <reason>]
//
// writes the result lines to stdout. Exit codes: 0 written, 1 failure, 2 usage error.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHECKS, CONTEXT_AREA, PROBE_AREAS } from './checks.mjs'
import { DriverUsageError, parseDriverArgs, runDriver } from './driver.mjs'

export const NOT_IMPLEMENTED = 'probe not implemented yet'

/** The checks of `area`, other than the context checks, that a driver started for `user` answers. */
export function placeholderIds(area, user, checks = CHECKS) {
  if (!PROBE_AREAS.includes(area)) throw new DriverUsageError(`area must be one of ${PROBE_AREAS.join(', ')}, not ${JSON.stringify(area)}`)
  return checks
    .filter((c) => c.kind === 'check' && c.area === area && c.area !== CONTEXT_AREA && (c.context.user === 'both' || c.context.user === user))
    .map((c) => c.id)
}

/** The accounts `area` has checks for, so its job knows which drivers to start. */
export function placeholderUsers(area, checks = CHECKS) {
  return ['admin', 'standard'].filter((user) => placeholderIds(area, user, checks).length > 0)
}

/** Runs the placeholder driver for a parsed command line; `options` are passed on to runDriver (tests). */
export async function runPlaceholder(args, options = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  const [area, ...rest] = positional
  if (area === undefined || rest.length > 0) throw new DriverUsageError(`expected one area, got ${JSON.stringify(positional)}`)
  const ids = placeholderIds(area, user)
  await runDriver({
    ...options,
    area,
    user,
    ids,
    unavailable,
    probe: (report) => {
      for (const id of ids) report(id, null, NOT_IMPLEMENTED, { placeholder: true })
    },
  })
}

/**
 * True when Node runs this file as the entry point. Node resolves symlinks for `import.meta.url`, so
 * argv[1] is too. Windows paths compare without case (a drive letter may differ), since a launcher or
 * driver that wrongly thinks it was imported would exit 0 having done nothing.
 */
function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    const [argv, self] = [realpathSync(process.argv[1]), fileURLToPath(import.meta.url)]
    return process.platform === 'win32' ? argv.toLowerCase() === self.toLowerCase() : argv === self
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  runPlaceholder(process.argv.slice(2)).then(
    () => {
      process.exitCode = 0
    },
    (error) => {
      const usage = error instanceof DriverUsageError
      console.error(`${usage ? 'usage: placeholder.mjs <area> --user admin|standard [--unavailable <reason>]: ' : 'placeholder.mjs: '}${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = usage ? 2 : 1
    },
  )
}
