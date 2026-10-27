#!/usr/bin/env node
// `npm run verify` (design D14): typecheck + lint + unit + integration + spec-coverage.
// Every stage runs even if an earlier one fails; the exit code reflects all of them.
import { spawnSync } from 'node:child_process'

const stages = ['typecheck', 'lint', 'test', 'test:integration', 'spec-coverage']
const results = []

// Under `npm run`, npm_execpath is npm's own CLI script, so running it with the current Node avoids
// both a PATH lookup and spawning `npm.cmd` on Windows, which Node 24 refuses without a shell
// (EINVAL). A non-JavaScript npm_execpath (another package manager's binary) is not runnable that way.
// Run directly (`node scripts/verify.mjs`), npm comes from PATH; on Windows it is a `.cmd` shim and
// needs a shell, given one command string because Node 24 deprecates arguments alongside `shell`.
// Joining is safe only because the stage names are fixed and contain no spaces or shell metacharacters.
function runStage(stage) {
  const args = ['run', '--silent', stage]
  const npmCli = process.env.npm_execpath
  if (npmCli && /\.[cm]?js$/i.test(npmCli)) return spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' })
  if (process.platform === 'win32') return spawnSync(['npm', ...args].join(' '), { stdio: 'inherit', shell: true })
  return spawnSync('npm', args, { stdio: 'inherit' })
}

for (const stage of stages) {
  console.log(`\n=== verify: ${stage} ===`)
  const started = Date.now()
  const run = runStage(stage)
  if (run.error) console.error(`verify: could not run ${stage}: ${run.error.message}`)
  results.push({ stage, ok: run.status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) })
}

console.log('\n=== verify summary ===')
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.stage.padEnd(18)} ${r.seconds}s`)
const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '\nverify: all stages passed' : `\nverify: ${failed.length} stage(s) failed`)
process.exitCode = failed.length === 0 ? 0 : 1
