// Sentinel fixture: an unrelated process started outside the supervisor. It records every
// catchable termination signal it receives (one line per signal) and keeps running, so a test can
// prove Veydr never signalled it. SIGKILL cannot be caught; a killed sentinel is simply not alive.
//
//   node sentinel.mjs --ledger <file> --signals <file>
import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { record, stayAlive } from './ledger.mjs'

const { values } = parseArgs({ options: { ledger: { type: 'string' }, signals: { type: 'string' } } })
if (values.ledger === undefined || values.signals === undefined) throw new Error('--ledger and --signals are required')
const signals = values.signals

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']) {
  process.on(signal, () => appendFileSync(signals, `${signal}\n`))
}
record(values.ledger, 'sentinel')
stayAlive()
