#!/usr/bin/env node
// Starts a probe job's results file with the job's identity line (design D4). Every Windows job of
// the windows-probe workflow runs it before any probe, so the summary, which runs on Ubuntu, takes
// the Windows identity from the results and never from its own environment.
//
//   node scripts/windows-probe/identity.mjs <area> <results-file>
//
// reads the runner's ImageOS and ImageVersion variables and NEGATIVE_CONTROL (`true` or `false`, the
// workflow's negative-control input), asks Windows PowerShell 5.1 for the Windows build, and creates
// <results-file> (refusing to overwrite one) holding the identity line. Exit codes: 0 written,
// 1 missing or invalid identity, or failure, 2 usage error.
import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROBE_AREAS } from './checks.mjs'

/** Thrown for an identity the summary would reject; `problems` lists every one found. */
export class IdentityError extends Error {
  constructor(problems) {
    super(`invalid identity:\n${problems.map((p) => `  ${p}`).join('\n')}`)
    this.name = 'IdentityError'
    this.problems = problems
  }
}

const token = (value) => typeof value === 'string' && /^\S+$/.test(value)

/**
 * The identity line of a probe job, without a line break. `env` is the job's environment
 * (ImageOS, ImageVersion, NEGATIVE_CONTROL). Throws IdentityError listing every problem, using the
 * same rules as summary.mjs, so a job never writes an identity the summary would reject.
 */
export function identityLine({ area, env, windowsBuild, node }) {
  const problems = []
  if (!PROBE_AREAS.includes(area)) problems.push(`area must be one of ${PROBE_AREAS.join(', ')}, not ${JSON.stringify(area)}`)
  const { ImageOS: imageOS, ImageVersion: imageVersion, NEGATIVE_CONTROL: negativeControl } = env
  for (const [name, value] of [['ImageOS', imageOS], ['ImageVersion', imageVersion]]) {
    if (!token(value)) problems.push(`${name} must be set, without spaces, as on a GitHub-hosted runner; got ${JSON.stringify(value)}`)
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(windowsBuild ?? '')) problems.push(`Windows build must be four numbers, not ${JSON.stringify(windowsBuild)}`)
  if (!token(node)) problems.push(`Node version must be a non-empty string without spaces, not ${JSON.stringify(node)}`)
  if (negativeControl !== 'true' && negativeControl !== 'false') {
    problems.push(`NEGATIVE_CONTROL must be "true" or "false", not ${JSON.stringify(negativeControl)}`)
  }
  if (problems.length > 0) throw new IdentityError(problems)
  return JSON.stringify({ identity: { area, imageOS, imageVersion, windowsBuild, node, negativeControl: negativeControl === 'true' } })
}

// `[Environment]::OSVersion` (design D4) leaves the revision at 0 under .NET Framework; the update
// build revision (UBR) in the registry is the number that changes with each cumulative update.
const BUILD_SCRIPT =
  "$v = [Environment]::OSVersion.Version; $ubr = (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -Name UBR).UBR; " +
  "'{0}.{1}.{2}.{3}' -f $v.Major, $v.Minor, $v.Build, $ubr"

/** The Windows build, `major.minor.build.UBR`, from Windows PowerShell 5.1 (design D2). */
function windowsBuild() {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', BUILD_SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  if (run.error !== undefined) throw new Error(`cannot run Windows PowerShell for the Windows build: ${run.error.message}`)
  if (run.status !== 0) throw new Error(`Windows PowerShell exited with ${String(run.status ?? run.signal)} reading the Windows build: ${run.stderr.trim()}`)
  return run.stdout.trim()
}

function main(args) {
  const [area, out, ...rest] = args
  if (area === undefined || out === undefined || rest.length > 0) {
    console.error(`usage: identity.mjs <area> <results-file> (got: ${args.join(' ')})`)
    return 2
  }
  // Checked before asking Windows, so a misconfigured job fails with every problem at once.
  identityLine({ area, env: process.env, windowsBuild: '0.0.0.0', node: process.version })
  const line = identityLine({ area, env: process.env, windowsBuild: windowsBuild(), node: process.version })
  mkdirSync(dirname(out), { recursive: true })
  // `wx`: the identity is the file's first line, so an existing file is an error, not something to append to.
  writeFileSync(out, `${line}\n`, { flag: 'wx' })
  console.log(line)
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
    console.error(`identity.mjs: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
