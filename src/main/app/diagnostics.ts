export interface DiagnosticEntry {
  readonly at: string
  readonly level: 'info' | 'warn' | 'error'
  readonly event: string
  readonly detail: Readonly<Record<string, unknown>>
}

export interface DiagnosticLog {
  record(level: DiagnosticEntry['level'], event: string, detail?: Record<string, unknown>): void
  entries(): readonly DiagnosticEntry[]
}

const MAX_ENTRIES = 500

/**
 * Application diagnostic log: a bounded in-memory ring mirrored to stderr.
 * It never writes to disk (no file logging in this change).
 */
export function createDiagnosticLog(
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): DiagnosticLog {
  const ring: DiagnosticEntry[] = []
  return {
    record(level, event, detail = {}) {
      const entry: DiagnosticEntry = { at: new Date().toISOString(), level, event, detail }
      ring.push(entry)
      if (ring.length > MAX_ENTRIES) ring.shift()
      sink(`[veydr:${level}] ${event} ${JSON.stringify(detail)}`)
    },
    entries: () => ring.slice(),
  }
}
