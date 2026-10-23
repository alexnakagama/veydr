// Process-tree fixture: a root with `--depth` levels of `--fanout` children each. Every process
// records itself in the ledger and stays alive until signalled.
//
//   node tree.mjs --ledger <file> [--depth N] [--fanout N] [--ignore-term]
//                 [--setpgid] [--escape] [--exit-after MS] [--exit-code N]
//
// --ignore-term   every process ignores SIGTERM (an uncooperative tree)
// --setpgid       the root's first child moves to its own process group (same session), through
//                 `bash -c 'set -m; …'`; the bash in between stays in the root's group
// --escape        the root's first child (its second with --setpgid) starts a new session
//                 (setsid, via `detached`)
// --exit-after    the root exits on its own after MS milliseconds, leaving its descendants
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { record, stayAlive } from './ledger.mjs'

const { values } = parseArgs({
  options: {
    ledger: { type: 'string' },
    depth: { type: 'string', default: '0' },
    fanout: { type: 'string', default: '1' },
    'ignore-term': { type: 'boolean', default: false },
    setpgid: { type: 'boolean', default: false },
    escape: { type: 'boolean', default: false },
    'exit-after': { type: 'string' },
    'exit-code': { type: 'string', default: '0' },
    role: { type: 'string', default: 'root' },
  },
})

const ledger = values.ledger
if (ledger === undefined) throw new Error('--ledger is required')
const depth = Number(values.depth)
const fanout = Number(values.fanout)
if (values['ignore-term']) process.on('SIGTERM', () => undefined)

const childArgs = (role) => [
  import.meta.filename,
  '--ledger',
  ledger,
  '--depth',
  String(depth - 1),
  '--fanout',
  String(fanout),
  '--role',
  role,
  ...(values['ignore-term'] ? ['--ignore-term'] : []),
]

const escapeIndex = values.escape ? (values.setpgid ? 1 : 0) : -1

for (let i = 0; depth > 0 && i < fanout; i++) {
  const role = `${values.role}.${i}`
  const stdio = ['ignore', 'inherit', 'inherit']
  if (i === 0 && values.setpgid) {
    spawn('/bin/bash', ['-c', 'set -m; "$@" & wait $!', 'bash', process.execPath, ...childArgs(`${role}:setpgid`)], { stdio })
  } else if (i === escapeIndex) {
    spawn(process.execPath, childArgs(`${role}:setsid`), { stdio, detached: true })
  } else {
    spawn(process.execPath, childArgs(role), { stdio })
  }
}

record(ledger, values.role)
stayAlive()

if (values['exit-after'] !== undefined) {
  setTimeout(() => process.exit(Number(values['exit-code'])), Number(values['exit-after']))
}
