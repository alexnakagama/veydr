#!/usr/bin/env node
// The process whose sockets the port probes look for (task 6.1). It listens on a port the system
// picks on each address named on its command line, prints one JSON line,
//
//   { "listeners": [{ "address": "127.0.0.1", "port": 49731 }, ...] }
//
// and stays until its stdin closes, which also happens if the driver dies, or LIFETIME_MS has passed.
// It closes every connection at once: 0.0.0.0 is reachable from outside the runner, and nothing
// needs to talk to it. Exit codes: 0 stopped, 1 failure, printed to stderr.
import { createServer } from 'node:net'

/** Longer than a driver's measurements take, and shorter than the launcher's timeout. */
const LIFETIME_MS = 230_000

const fail = (error) => {
  process.stderr.write(`port-listener.mjs: ${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1))
}

const listen = (host) =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on('error', () => {})
      socket.destroy()
    })
    server.once('error', reject)
    server.listen({ host, port: 0, exclusive: true }, () => {
      const { port } = server.address()
      resolve({ address: host, port })
    })
  })

async function run(addresses) {
  if (addresses.length === 0) throw new Error('expected at least one address')
  const listeners = await Promise.all(addresses.map(listen))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
  setTimeout(() => process.exit(0), LIFETIME_MS)
  process.stdout.write(`${JSON.stringify({ listeners })}\n`)
}

run(process.argv.slice(2)).catch(fail)
