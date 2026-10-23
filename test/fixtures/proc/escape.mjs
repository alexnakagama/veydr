// Escape fixture: leader → middle → escapee. The escapee starts a new session (setsid, via
// `detached`) and the middle process exits `--middle-exit-ms` after spawning it, so the escapee is
// an orphan outside the leader's session and process group (design D8 known limitation).
//
//   node escape.mjs --ledger <file> [--middle-exit-ms MS]
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { record, stayAlive } from './ledger.mjs'

const { values } = parseArgs({
  options: {
    ledger: { type: 'string' },
    'middle-exit-ms': { type: 'string', default: '0' },
    role: { type: 'string', default: 'leader' },
  },
})

const ledger = values.ledger
if (ledger === undefined) throw new Error('--ledger is required')
const self = import.meta.filename
const stdio = ['ignore', 'inherit', 'inherit']

switch (values.role) {
  case 'leader':
    spawn(process.execPath, [self, '--ledger', ledger, '--role', 'middle', '--middle-exit-ms', values['middle-exit-ms']], { stdio })
    record(ledger, 'leader')
    stayAlive()
    break
  case 'middle': {
    spawn(process.execPath, [self, '--ledger', ledger, '--role', 'escapee'], { stdio, detached: true }).unref()
    record(ledger, 'middle')
    setTimeout(() => process.exit(0), Number(values['middle-exit-ms']))
    break
  }
  case 'escapee':
    record(ledger, 'escapee')
    stayAlive()
    break
  default:
    throw new Error(`unknown role ${values.role}`)
}
