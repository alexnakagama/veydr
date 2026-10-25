import type { z } from 'zod'
import { contractEntries, internalContract, type Contract, type InvokeSpec } from '../../shared/api'
import type { EventHub } from './events'
import type { Handler, IpcRegistry } from './register'

type InvokeKeys<G extends keyof Contract> = {
  [K in keyof Contract[G]]: Contract[G][K] extends InvokeSpec ? K : never
}[keyof Contract[G]]

/** A handler receives the parsed request and returns a value the response schema accepts. */
export type HandlerFor<S> = S extends InvokeSpec<infer Req, infer Res> ? Handler<z.output<Req>, z.input<Res>> : never

/** One handler per request/response operation of the contract; the compiler rejects a missing one. */
export type OperationHandlers = {
  readonly [G in keyof Contract]: { readonly [K in InvokeKeys<G>]: HandlerFor<Contract[G][K]> }
}

/** Registers every request/response operation of the contract with its schemas. */
export function registerOperations(registry: IpcRegistry, handlers: OperationHandlers): void {
  const byGroup = handlers as unknown as Readonly<Record<string, Readonly<Record<string, Handler<unknown, unknown>>>>>
  for (const { group, name, spec } of contractEntries) {
    if (spec.kind !== 'invoke') continue
    const handler = byGroup[group]?.[name]
    if (handler === undefined) throw new Error(`No handler for ${group}.${name}`)
    registry.handle(spec.channel, spec.request, spec.response, handler)
  }
}

/** Registers the preload bridge's internal subscribe/unsubscribe requests (sender-checked like any operation). */
export function registerEventSubscriptions(registry: IpcRegistry, hub: EventHub): void {
  const { subscribe, unsubscribe } = internalContract
  registry.handle(subscribe.channel, subscribe.request, subscribe.response, ({ topic, token }, { sender }) => {
    hub.subscribe(sender, topic, token)
    return null
  })
  registry.handle(unsubscribe.channel, unsubscribe.request, unsubscribe.response, ({ topic, token }, { sender }) => {
    hub.unsubscribe(sender, topic, token)
    return null
  })
}
