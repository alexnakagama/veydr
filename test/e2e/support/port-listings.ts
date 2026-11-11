import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// How many port listings Veydr's main process made, counted by `ports-probe.cjs` (design D7): on
// Linux each listing reads /proc/net/tcp once, on Windows it runs the helper's `ports` once. Each
// system writes one of the two logs; both are counted, so the count needs no platform branch.

export interface PortListingLogs {
  /** The environment that makes `ports-probe.cjs` write both logs; pass it to `launchVeydr`. */
  readonly env: Readonly<Record<string, string>>
  /** Listings so far, from whichever log the system writes. */
  readonly count: () => number
}

const lines = (path: string): number => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0)

/** Logs in `dir`, which must be the test's own directory. */
export function portListingLogs(dir: string): PortListingLogs {
  const reads = join(dir, 'port-reads.log')
  const helperCalls = join(dir, 'helper-ports.log')
  return {
    env: { VEYDR_TEST_PORT_READS: reads, VEYDR_TEST_HELPER_PORTS: helperCalls },
    count: () => lines(reads) + lines(helperCalls),
  }
}
