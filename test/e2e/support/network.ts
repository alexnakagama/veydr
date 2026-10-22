import { existsSync, readFileSync } from 'node:fs'

export interface NetworkAttempt {
  readonly source: 'node' | 'chromium'
  readonly kind: string
  readonly detail: string
}

export interface NetworkReport {
  /** Both observers were active for the run; an empty report is meaningless otherwise. */
  readonly guardInstalled: boolean
  readonly netLogPresent: boolean
  readonly attempts: readonly NetworkAttempt[]
}

/** Schemes served in-process; requests for them never reach the network. */
const LOCAL_SCHEMES = ['app:', 'data:', 'blob:', 'about:', 'devtools:', 'chrome:', 'chrome-extension:', 'file:']

function readNodeLog(path: string): { installed: boolean; attempts: NetworkAttempt[] } {
  if (!existsSync(path)) return { installed: false, attempts: [] }
  let installed = false
  const attempts: NetworkAttempt[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const entry = JSON.parse(line) as Record<string, unknown>
    const kind = String(entry['kind'])
    if (kind === 'installed') installed = true
    else if (kind !== 'ipc') {
      attempts.push({ source: 'node', kind, detail: `${String(entry['api'])} ${JSON.stringify(entry)}` })
    }
  }
  return { installed, attempts }
}

/** Parses a Chromium net-log; a log cut short at exit is repaired by closing its event array. */
function parseNetLog(text: string): { constants: { logEventTypes: Record<string, number> }; events: unknown[] } {
  try {
    return JSON.parse(text) as ReturnType<typeof parseNetLog>
  } catch {
    const trimmed = text.trimEnd().replace(/,$/, '')
    return JSON.parse(`${trimmed}]}`) as ReturnType<typeof parseNetLog>
  }
}

/**
 * Net-log events that mean packets (or name lookups) left the process. Beyond URL
 * requests this covers raw sockets, which is how WebRTC/STUN traffic shows up
 * (`UDP_BYTES_SENT`, no URL). A clean idle run produces none of these. `UDP_LOCAL_ADDRESS`
 * (a local bind) is deliberately excluded: WebRTC binds sockets while gathering candidates
 * even when nothing is sent.
 */
const CONNECTION_EVENTS = [
  'TCP_CONNECT',
  'TCP_CONNECT_ATTEMPT',
  'SOCKET_CONNECT',
  'SOCKET_BYTES_SENT',
  'UDP_CONNECT',
  'UDP_BYTES_SENT',
  'HOST_RESOLVER_DNS_TASK',
  'HOST_RESOLVER_MANAGER_REQUEST',
  'DNS_TRANSACTION',
]

function readNetLog(path: string): { present: boolean; attempts: NetworkAttempt[] } {
  if (!existsSync(path)) return { present: false, attempts: [] }
  const log = parseNetLog(readFileSync(path, 'utf8'))
  const nameOf = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]))
  const attempts: NetworkAttempt[] = []
  for (const raw of log.events) {
    const event = raw as { type: number; params?: Record<string, unknown> }
    const name = nameOf.get(event.type) ?? String(event.type)
    const params = event.params ?? {}
    const url = params['url']
    if (typeof url === 'string' && !LOCAL_SCHEMES.some((scheme) => url.startsWith(scheme))) {
      attempts.push({ source: 'chromium', kind: name, detail: url })
    } else if (CONNECTION_EVENTS.includes(name)) {
      attempts.push({ source: 'chromium', kind: name, detail: JSON.stringify(params) })
    }
  }
  return { present: true, attempts }
}

export function collectNetworkReport(nodeLogPath: string, netLogPath: string): NetworkReport {
  const node = readNodeLog(nodeLogPath)
  const chromium = readNetLog(netLogPath)
  return {
    guardInstalled: node.installed,
    netLogPresent: chromium.present,
    attempts: [...node.attempts, ...chromium.attempts],
  }
}
