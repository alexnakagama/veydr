import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticLog } from '../../src/main/app/diagnostics'
import { createEventHub, type EventSubscriber } from '../../src/main/ipc/events'
import { channels, type ProcessStateEvent } from '../../src/shared/api'

const topic = channels.processes.onState
const noticeTopic = channels.app.onNotice
const tokenA = '11111111-1111-4111-8111-111111111111'
const tokenB = '22222222-2222-4222-8222-222222222222'

class FakeContents implements EventSubscriber {
  destroyed = false
  failing = false
  readonly sent: { channel: string; payload: unknown }[] = []
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error('Object has been destroyed')
    if (this.failing) throw new Error('send failed')
    this.sent.push({ channel, payload })
  }
}

let seq = 0
function stateEvent(): ProcessStateEvent {
  seq += 1
  return {
    commandId: '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01',
    runId: '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22',
    seq,
    status: 'running',
    pid: 1234,
    startedAt: 1_700_000_000_000,
    exit: null,
    error: null,
    survivors: [],
  }
}

function setup() {
  const log = createDiagnosticLog(() => undefined)
  return { hub: createEventHub(log), log }
}

describe('event hub: subscriber tracking per webContents', () => {
  it('sends a topic only to its subscribers', () => {
    const { hub } = setup()
    const a = new FakeContents(1)
    const b = new FakeContents(2)
    hub.subscribe(a, topic, tokenA)
    hub.subscribe(b, noticeTopic, tokenB)
    const event = stateEvent()
    hub.publish(topic, event)
    expect(a.sent).toEqual([{ channel: topic, payload: event }])
    expect(b.sent).toEqual([])
    expect(hub.subscriberCount(topic)).toBe(1)
  })

  it('drops sends to destroyed contents and forgets them', () => {
    const { hub, log } = setup()
    const live = new FakeContents(1)
    const gone = new FakeContents(2)
    hub.subscribe(live, topic, tokenA)
    hub.subscribe(gone, topic, tokenB)
    gone.destroyed = true

    hub.publish(topic, stateEvent())
    hub.publish(topic, stateEvent())
    expect(gone.sent).toEqual([])
    expect(live.sent).toHaveLength(2)
    expect(hub.subscriberCount(topic)).toBe(1)
    expect(log.entries().filter((e) => e.event === 'events.dropped-destroyed')).toHaveLength(1)
  })

  it('forgets a subscriber whose send throws, without affecting the others', () => {
    const { hub, log } = setup()
    const broken = new FakeContents(1)
    const live = new FakeContents(2)
    hub.subscribe(broken, topic, tokenA)
    hub.subscribe(live, topic, tokenB)
    broken.failing = true
    expect(() => hub.publish(topic, stateEvent())).not.toThrow()
    expect(live.sent).toHaveLength(1)
    expect(hub.subscriberCount(topic)).toBe(1)
    expect(log.entries().find((e) => e.event === 'events.send-failed')?.detail).toMatchObject({ contentsId: 1, topic })
  })

  it('forgets every subscription of contents dropped on destroy or renderer exit', () => {
    const { hub } = setup()
    const contents = new FakeContents(7)
    hub.subscribe(contents, topic, tokenA)
    hub.subscribe(contents, noticeTopic, tokenA)
    hub.drop(7)
    hub.publish(topic, stateEvent())
    expect(contents.sent).toEqual([])
    expect(hub.subscriberCount(topic)).toBe(0)
    expect(hub.subscriberCount(noticeTopic)).toBe(0)
    expect(() => hub.drop(7)).not.toThrow()
  })

  it('drops the previous document’s subscriptions when a reloaded document subscribes', () => {
    const { hub, log } = setup()
    const contents = new FakeContents(3)
    hub.subscribe(contents, topic, tokenA)
    hub.subscribe(contents, noticeTopic, tokenA)

    // The reloaded document only subscribes to notices: state events must stop.
    hub.subscribe(contents, noticeTopic, tokenB)
    hub.publish(topic, stateEvent())
    expect(contents.sent).toEqual([])
    expect(hub.subscriberCount(noticeTopic)).toBe(1)
    expect(log.entries().find((e) => e.event === 'events.document-replaced')?.detail).toEqual({
      contentsId: 3,
      dropped: [topic, noticeTopic],
    })

    // A late unsubscribe from the old document does not touch the new one.
    hub.unsubscribe(contents, noticeTopic, tokenA)
    expect(hub.subscriberCount(noticeTopic)).toBe(1)
    hub.unsubscribe(contents, noticeTopic, tokenB)
    expect(hub.subscriberCount(noticeTopic)).toBe(0)
  })

  it('validates payloads against the contract and sends the parsed value', () => {
    const { hub, log } = setup()
    const contents = new FakeContents(1)
    hub.subscribe(contents, topic, tokenA)
    hub.publish(topic, { ...stateEvent(), seq: 0 })
    hub.publish(topic, { ...stateEvent(), secret: 'hunter2' } as ProcessStateEvent)
    expect(contents.sent).toEqual([])
    const invalid = log.entries().filter((e) => e.event === 'events.invalid-payload')
    expect(invalid).toHaveLength(2)
    expect(JSON.stringify(invalid)).not.toContain('hunter2')
  })

  it('skips validation and sending when nobody listens', () => {
    const { hub, log } = setup()
    hub.publish(topic, { ...stateEvent(), seq: 0 })
    expect(log.entries()).toEqual([])
  })

  it('sends to one subscriber only if it subscribed to the topic, and runs subscribe hooks', () => {
    const { hub } = setup()
    const contents = new FakeContents(1)
    const other = new FakeContents(2)
    const hook = vi.fn((subscriber: EventSubscriber) => hub.sendTo(subscriber, topic, stateEvent()))
    hub.onSubscribe(topic, hook)

    hub.sendTo(contents, topic, stateEvent())
    expect(contents.sent).toEqual([])

    hub.subscribe(contents, topic, tokenA)
    expect(hook).toHaveBeenCalledWith(contents)
    expect(contents.sent).toHaveLength(1)
    hub.subscribe(other, noticeTopic, tokenB)
    expect(hook).toHaveBeenCalledTimes(1)
    hub.sendTo(other, topic, stateEvent())
    expect(other.sent).toEqual([])
  })
})
