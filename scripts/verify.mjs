#!/usr/bin/env node
// `npm run verify` (design D14): typecheck + lint + unit + integration + spec-coverage.
// Every stage runs even if an earlier one fails; the exit code reflects all of them.
import { spawnNpm } from './npm.mjs'

const stages = ['typecheck', 'lint', 'test', 'test:integration', 'spec-coverage']
const results = []

const runStage = (stage) => spawnNpm(['run', '--silent', stage], { stdio: 'inherit' })

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
