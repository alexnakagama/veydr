// Listener fixture: listens on TCP ports and records them in the ledger. Used by port-inspection
// tests.
//
//   node listen.mjs --ledger <file> [--host 127.0.0.1] [--port 0] [--count N] [--depth N] [--escape]
//
// --port     port of the first socket; 0 (default) lets the OS pick a free one
// --count    listens on N sockets (further sockets always get OS-picked ports)
// --depth    starts a chain of N processes first; only the last one listens (2: a grandchild)
// --escape   the listening process starts a new session (setsid, via `detached`)
//
// The listening process records `port` (the first) and `ports` (all of them) once it listens.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { parseArgs } from 'node:util'
import { record, stayAlive } from './ledger.mjs'

const { values } = parseArgs({
  options: {
    ledger: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '0' },
    count: { type: 'string', default: '1' },
    depth: { type: 'string', default: '0' },
    escape: { type: 'boolean', default: false },
    role: { type: 'string', default: 'listener' },
  },
})
if (values.ledger === undefined) throw new Error('--ledger is required')
const ledger = values.ledger
const depth = Number(values.depth)

if (depth > 0) {
  // An intermediate process: starts the next one and stays alive.
  const args = [import.meta.filename, '--ledger', ledger, '--host', values.host, '--port', values.port, '--count', values.count, '--depth', String(depth - 1), '--role', values.role]
  if (values.escape) args.push('--escape')
  spawn(process.execPath, args, { stdio: 'inherit', detached: values.escape && depth === 1 })
  record(ledger, `intermediate-${depth}`)
  stayAlive()
} else {
  const listen = (port) =>
    new Promise((done, fail) => {
      const server = createServer((socket) => socket.destroy())
      server.once('error', fail)
      server.listen(port, values.host, () => {
        const address = server.address()
        done(typeof address === 'object' && address !== null ? address.port : null)
      })
    })
  const count = Number(values.count)
  const ports = []
  for (let i = 0; i < count; i++) ports.push(await listen(i === 0 ? Number(values.port) : 0))
  record(ledger, values.role, { port: ports[0] ?? null, ports })
}
