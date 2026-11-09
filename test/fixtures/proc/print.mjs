// Print fixture: writes a scripted sequence of output, the same on every system, where a test would
// otherwise use `sh -c 'printf …; sleep …'` (add-windows-environment-and-commands design D7).
//
//   node print.mjs --steps <base64url JSON> [--stay]
//
// The steps are base64url-encoded JSON, so arguments are plain ASCII on every command-line route,
// whatever the text holds (escape sequences, quotes, line endings). Each step is one of:
//
//   { "stream": "out" | "err", "text": "…", "env": "NAME" }  writes `text`; with `env`, every `%s`
//                                                            becomes the value of NAME (it must be set)
//   { "sleepMs": N }                                         waits N milliseconds
//   { "run": ["arg", …] }                                    runs Node with these arguments, its output
//                                                            going to this process's, and waits for it
//   { "everyMs": N, "stream": "out" | "err", "text": "…" }   from then on writes `text` every N ms,
//                                                            `%d` replaced by 1, 2, 3, …; never ends
//
// After the last step the process exits, or with `--stay` keeps running until it is stopped.
// Writes are synchronous, so the order of the steps is the order of the output on each stream.
import { spawnSync } from 'node:child_process'
import { writeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { stayAlive } from './ledger.mjs'

const { values } = parseArgs({ options: { steps: { type: 'string' }, stay: { type: 'boolean', default: false } } })
if (values.steps === undefined) throw new Error('--steps is required')
const steps = JSON.parse(Buffer.from(values.steps, 'base64url').toString('utf8'))
if (!Array.isArray(steps)) throw new Error('--steps must encode a list')

const fd = (stream) => {
  if (stream === 'out') return 1
  if (stream === 'err') return 2
  throw new Error(`unknown stream ${JSON.stringify(stream)}`)
}

const expand = (step) => {
  if (typeof step.text !== 'string') throw new Error(`a step without text: ${JSON.stringify(step)}`)
  if (step.env === undefined) return step.text
  const value = process.env[step.env]
  if (value === undefined) throw new Error(`${step.env} is not set`)
  return step.text.replaceAll('%s', value)
}

for (const step of steps) {
  if (typeof step.sleepMs === 'number') {
    await sleep(step.sleepMs)
  } else if (Array.isArray(step.run)) {
    const run = spawnSync(process.execPath, step.run, { stdio: ['ignore', 'inherit', 'inherit'] })
    if (run.status !== 0) throw new Error(`${JSON.stringify(step.run)} failed: ${String(run.error ?? run.status ?? run.signal)}`)
  } else if (typeof step.everyMs === 'number') {
    for (let i = 1; ; i++) {
      await sleep(step.everyMs)
      writeSync(fd(step.stream), expand(step).replaceAll('%d', String(i)))
    }
  } else {
    writeSync(fd(step.stream), expand(step))
  }
}

if (values.stay) stayAlive()
