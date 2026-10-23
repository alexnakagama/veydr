// Listener fixture: listens on a TCP port (loopback, `--port 0` picks a free one) and records the
// port in the ledger. Used by port-inspection tests.
//
//   node listen.mjs --ledger <file> [--host 127.0.0.1] [--port 0]
import { createServer } from 'node:net'
import { parseArgs } from 'node:util'
import { record } from './ledger.mjs'

const { values } = parseArgs({
  options: {
    ledger: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '0' },
    role: { type: 'string', default: 'listener' },
  },
})
if (values.ledger === undefined) throw new Error('--ledger is required')
const ledger = values.ledger

const server = createServer((socket) => socket.destroy())
server.listen(Number(values.port), values.host, () => {
  const address = server.address()
  record(ledger, values.role, { port: typeof address === 'object' && address !== null ? address.port : null })
})
