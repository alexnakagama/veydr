import { describe, expect, it } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { createNoticeCenter, MAX_NOTICES, noticeFromConfig } from '../../src/main/app/notices'
import type { ConfigNoticeKind } from '../../src/main/config'
import { createEventHub, type EventSubscriber } from '../../src/main/ipc/events'
import { channels, noticeKinds, noticeSchema, type Notice } from '../../src/shared/api'

const topic = channels.app.onNotice
const token = '11111111-1111-4111-8111-111111111111'

function contents(id: number): EventSubscriber & { readonly sent: unknown[] } {
  const sent: unknown[] = []
  return { id, sent, isDestroyed: () => false, send: (_channel: string, payload: unknown) => sent.push(payload) }
}

function setup() {
  const hub = createEventHub(createDiagnosticLog(() => undefined))
  return { hub, notices: createNoticeCenter(hub) }
}

const recovered: Omit<Notice, 'id'> = { kind: 'recovered-from-backup', severity: 'warning', message: 'Loaded the backup.', files: ['/c/x'] }

describe('notice center (app.onNotice)', () => {
  it('replays notices raised before a document subscribed, then sends new ones live', () => {
    const { hub, notices } = setup()
    const first = notices.add(recovered)
    const window = contents(1)
    hub.subscribe(window, topic, token)
    expect(window.sent).toEqual([first])

    const second = notices.add({ ...recovered, kind: 'save-failed', severity: 'error' })
    expect(window.sent).toEqual([first, second])
    expect(first.id).not.toBe(second.id)
    expect(noticeSchema.safeParse(second).success).toBe(true)
  })

  it('replays all retained notices to a reloaded document', () => {
    const { hub, notices } = setup()
    const window = contents(1)
    hub.subscribe(window, topic, token)
    const added = notices.add(recovered)
    hub.subscribe(window, topic, '22222222-2222-4222-8222-222222222222')
    expect(window.sent).toEqual([added, added])
  })

  it(`keeps at most ${MAX_NOTICES} notices, dropping the oldest of the lowest severity first`, () => {
    const { notices } = setup()
    const startup = notices.add({ kind: 'reset-to-empty', severity: 'error', message: 'Started empty.', files: [] })
    for (let i = 0; i < MAX_NOTICES + 5; i += 1) notices.add({ ...recovered, message: `n${i}` })
    const kept = notices.list()
    expect(kept).toHaveLength(MAX_NOTICES)
    expect(kept[0]).toEqual(startup)
    expect(kept[1]?.message).toBe('n6')

    // With only errors left, the oldest error goes.
    const { notices: errors } = setup()
    for (let i = 0; i < MAX_NOTICES + 1; i += 1) errors.add({ kind: 'save-failed', severity: 'error', message: `e${i}`, files: [] })
    expect(errors.list()[0]?.message).toBe('e1')
  })

  it('shows but does not retain a new notice that is the least severe one at the cap', () => {
    const { hub, notices } = setup()
    const window = contents(1)
    hub.subscribe(window, topic, token)
    for (let i = 0; i < MAX_NOTICES; i += 1) notices.add({ kind: 'save-failed', severity: 'error', message: `e${i}`, files: [] })
    const info = notices.add({ ...recovered, severity: 'info' })
    expect(window.sent.at(-1)).toEqual(info)
    expect(notices.list()).toHaveLength(MAX_NOTICES)
    expect(notices.list()).not.toContainEqual(info)
  })

  it('does not repeat an identical notice', () => {
    const { hub, notices } = setup()
    const window = contents(1)
    hub.subscribe(window, topic, token)
    const first = notices.add(recovered)
    expect(notices.add({ ...recovered, files: [...recovered.files] })).toBe(first)
    expect(notices.add({ ...recovered, files: ['/c/other'] })).not.toBe(first)
    expect(notices.list()).toHaveLength(2)
    expect(window.sent).toHaveLength(2)
  })

  it('tells notices apart by the processes they list, and copies them', () => {
    const { notices } = setup()
    const node = { pid: 10, name: 'node', commandLine: 'node server.js' }
    const survivors: Omit<Notice, 'id'> = { kind: 'crash-survivors', severity: 'warning', message: '1 process is still running.', files: [], processes: [node] }
    const first = notices.add(survivors)
    expect(notices.add({ ...survivors, processes: [{ ...node }] })).toBe(first)
    expect(notices.add({ ...survivors, processes: [{ ...node, pid: 11 }] })).not.toBe(first)
    expect(notices.add({ ...survivors, processes: [] })).not.toBe(first)
    expect(first.processes).toEqual([node])
    expect(first.processes?.[0]).not.toBe(node)
    expect(noticeSchema.safeParse(first).success).toBe(true)
  })

  it('withdraws a notice so later subscribers do not receive it', () => {
    const { hub, notices } = setup()
    const kept = notices.add(recovered)
    const withdrawn = notices.add({ ...recovered, kind: 'crash-survivors', processes: [{ pid: 3, name: 'x', commandLine: 'x' }] })
    notices.withdraw(withdrawn.id)
    notices.withdraw('notice-unknown')
    expect(notices.list()).toEqual([kept])
    const window = contents(2)
    hub.subscribe(window, topic, token)
    expect(window.sent.map((m) => (m as Notice).id)).toEqual([kept.id])
  })

  it('maps every configuration notice kind to a notice kind with a severity', () => {
    const kinds: readonly ConfigNoticeKind[] = ['recovered-from-backup', 'reset-to-empty', 'newer-schema', 'preservation-failed', 'save-failed']
    // The other notice kinds come from crash recovery and quitting (L4) and the login environment (L5).
    expect([...kinds, 'crash-survivors', 'ledger-problem', 'quitting', 'environment'].sort()).toEqual([...noticeKinds].sort())
    for (const kind of kinds) {
      const notice = noticeFromConfig({ kind, message: 'm', files: ['/a'] })
      expect(notice.kind).toBe(kind)
      expect(noticeSchema.safeParse({ ...notice, id: 'notice-1' }).success).toBe(true)
    }
    expect(noticeFromConfig({ kind: 'reset-to-empty', message: 'm', files: [] }).severity).toBe('error')
    expect(noticeFromConfig({ kind: 'recovered-from-backup', message: 'm', files: [] }).severity).toBe('warning')
  })
})
