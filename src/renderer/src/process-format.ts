import type { ExitInfo, ProcessInfo } from '../../shared/api'

/** `m:ss` below an hour, `h:mm:ss` above; negative durations (clock skew) count as zero. */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** How a run ended: exit code or terminating signal, and whether Veydr forced it. */
export function describeExit(exit: ExitInfo | null): string {
  let text: string
  if (exit?.code !== null && exit?.code !== undefined) text = `Exited with code ${exit.code}`
  else if (exit?.signal !== null && exit?.signal !== undefined) text = `Terminated by ${exit.signal}`
  else text = 'Exited'
  return exit?.forced === true ? `${text} (forced after the stop timeout)` : text
}

export function describeSurvivors(survivors: readonly ProcessInfo[]): string {
  return `Still running after the stop: ${survivors.map((s) => `PID ${s.pid} (${s.name})`).join(', ')}`
}
