'use strict'
// Loaded into the Electron main process with `NODE_OPTIONS=--require` by the
// E2E harness. Records every Node-level network attempt (TCP/TLS connects,
// UDP sends, DNS lookups) to the JSONL file in VEYDR_NET_GUARD_LOG. Chromium
// network activity is captured separately through `--log-net-log`.
const fs = require('node:fs')
const net = require('node:net')
const dgram = require('node:dgram')
const dns = require('node:dns')

const logPath = process.env.VEYDR_NET_GUARD_LOG
if (logPath) {
  const record = (entry) => {
    try {
      fs.appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
    } catch {
      // The guard must never change app behaviour.
    }
  }

  const describeConnect = (args) => {
    const first = args[0]
    if (Array.isArray(first)) return describeConnect(first)
    if (first !== null && typeof first === 'object') {
      if (typeof first.path === 'string') return { kind: 'ipc', path: first.path }
      return { kind: 'tcp', host: first.host ?? 'localhost', port: first.port }
    }
    if (typeof first === 'string' && Number.isNaN(Number(first))) return { kind: 'ipc', path: first }
    return { kind: 'tcp', host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first }
  }

  const originalConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function guardedConnect(...args) {
    record({ source: 'node', api: 'net.Socket.connect', ...describeConnect(args) })
    return originalConnect.apply(this, args)
  }

  for (const method of ['send', 'connect']) {
    const original = dgram.Socket.prototype[method]
    dgram.Socket.prototype[method] = function guardedDgram(...args) {
      record({ source: 'node', api: `dgram.Socket.${method}`, kind: 'udp' })
      return original.apply(this, args)
    }
  }

  for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
    const original = dns[method]
    dns[method] = function guardedDns(hostname, ...rest) {
      record({ source: 'node', api: `dns.${method}`, kind: 'dns', host: hostname })
      return original.call(this, hostname, ...rest)
    }
    const originalPromise = dns.promises[method]
    dns.promises[method] = function guardedDnsPromise(hostname, ...rest) {
      record({ source: 'node', api: `dns.promises.${method}`, kind: 'dns', host: hostname })
      return originalPromise.call(this, hostname, ...rest)
    }
  }

  record({ source: 'node', api: 'guard', kind: 'installed' })
}
