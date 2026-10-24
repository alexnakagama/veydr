import { channels, type Notice, type NoticeKind, type NoticeSeverity } from '../../shared/api'
import type { ConfigNotice, ConfigNoticeKind } from '../config'
import type { EventHub } from '../ipc/events'

/** Notices kept per session; beyond this, the least severe (then oldest) is dropped. */
export const MAX_NOTICES = 50

export interface NoticeCenter {
  /**
   * Records a notice for this session and sends it to current subscribers. A notice identical to a
   * retained one (kind, severity, message, files) is not repeated; the retained one is returned.
   * At the cap, if the new notice is itself the least severe, it is shown live but not retained,
   * so `list()` (and a reloaded window) will not include it.
   */
  add(notice: Omit<Notice, 'id'>): Notice
  /**
   * Stops retaining a notice that no longer applies (e.g. resolved survivors), so documents that
   * subscribe later do not receive it. Documents that already show it are not told; the one that
   * resolved it hides it.
   */
  withdraw(id: string): void
  list(): readonly Notice[]
}

const severityRank: Readonly<Record<NoticeSeverity, number>> = { info: 0, warning: 1, error: 2 }

const sameProcesses = (a: Notice['processes'], b: Notice['processes']): boolean =>
  (a ?? []).length === (b ?? []).length &&
  (a ?? []).every((p, i) => {
    const other = b?.[i]
    return other !== undefined && p.pid === other.pid && p.name === other.name && p.commandLine === other.commandLine
  })

const sameNotice = (a: Omit<Notice, 'id'>, b: Omit<Notice, 'id'>): boolean =>
  a.kind === b.kind &&
  a.severity === b.severity &&
  a.message === b.message &&
  a.files.length === b.files.length &&
  a.files.every((file, i) => file === b.files[i]) &&
  sameProcesses(a.processes, b.processes)

/**
 * Session notices for `app.onNotice`. Every subscribing document first receives all retained
 * notices (in order), so notices raised before the window loaded, or before a reload, are shown.
 */
export function createNoticeCenter(hub: EventHub): NoticeCenter {
  const topic = channels.app.onNotice
  const notices: Notice[] = []
  let next = 1

  hub.onSubscribe(topic, (subscriber) => {
    for (const notice of notices) hub.sendTo(subscriber, topic, notice)
  })

  /** Drops the oldest notice of the lowest severity present, so startup errors outlive bursts of warnings. */
  function evict(): void {
    let victim = 0
    notices.forEach((notice, i) => {
      const current = notices[victim]
      if (current !== undefined && severityRank[notice.severity] < severityRank[current.severity]) victim = i
    })
    notices.splice(victim, 1)
  }

  return {
    add(notice) {
      const existing = notices.find((retained) => sameNotice(retained, notice))
      if (existing !== undefined) return existing
      const recorded: Notice = {
        ...notice,
        files: [...notice.files],
        ...(notice.processes === undefined ? {} : { processes: notice.processes.map((p) => ({ ...p })) }),
        id: `notice-${next}`,
      }
      next += 1
      notices.push(recorded)
      if (notices.length > MAX_NOTICES) evict()
      hub.publish(topic, recorded)
      return recorded
    },
    withdraw(id) {
      const index = notices.findIndex((notice) => notice.id === id)
      if (index >= 0) notices.splice(index, 1)
    },
    list: () => notices.slice(),
  }
}

const configSeverity: Readonly<Record<ConfigNoticeKind, NoticeSeverity>> = {
  'recovered-from-backup': 'warning',
  'reset-to-empty': 'error',
  'newer-schema': 'warning',
  'preservation-failed': 'error',
  'save-failed': 'error',
}

/** The user-facing notice for a configuration notice. */
export function noticeFromConfig(notice: ConfigNotice): Omit<Notice, 'id'> {
  const kind: NoticeKind = notice.kind
  return { kind, severity: configSeverity[notice.kind], message: notice.message, files: [...notice.files] }
}
