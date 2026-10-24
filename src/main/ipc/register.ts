import type { ZodType } from 'zod'
import { fail, ok, type ApiResult } from '../../shared/api'
import type { DiagnosticLog } from '../app/diagnostics'
import { NotFoundError, ShuttingDownError, UserError } from '../errors'
import { NotImplementedError, UnsupportedPlatformError } from '../platform/errors'
import type { EventSubscriber } from './events'

/** The subset of a frame the sender check needs (Electron `WebFrameMain`). */
export interface SenderFrame {
  readonly url: string
  readonly detached?: boolean
}

/** The subset of `IpcMainInvokeEvent` the helper needs. */
export interface InvokeEvent {
  readonly senderFrame: SenderFrame | null
  /** The `webContents` that sent the request. */
  readonly sender: EventSubscriber
}

/** The subset of `ipcMain` the helper needs. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEvent, ...args: unknown[]) => unknown): void
}

export interface IpcRegistryOptions {
  readonly ipcMain: IpcMainLike
  /** Returns the main frame of the application window, if one exists. */
  readonly mainFrame: () => SenderFrame | null
  /** Origin of the bundled content, e.g. `app://veydr`. */
  readonly trustedOrigin: string
  readonly log: DiagnosticLog
}

/** What a handler may know about the request besides its payload. */
export interface HandlerContext {
  readonly sender: EventSubscriber
}

export type Handler<I, O> = (input: I, context: HandlerContext) => O | Promise<O>

export interface IpcRegistry {
  /**
   * Registers `handler` for `channel`. The payload is parsed with `request` before the handler
   * runs, and the handler's value is parsed with `response` before it is returned, so nothing
   * outside the declared response shape (e.g. a secret value) can reach the renderer.
   */
  handle<I, R, O>(channel: string, request: ZodType<I>, response: ZodType<O, R>, handler: Handler<I, R>): void
  readonly channels: readonly string[]
}

/** Origin of a URL, including non-special schemes such as `app:` whose `URL.origin` is `"null"`. */
export function originOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.host === '') return null
  return `${parsed.protocol}//${parsed.host}`
}

/** True only for the main frame of our window showing our bundled content. */
export function isTrustedSender(
  frame: SenderFrame | null,
  mainFrame: SenderFrame | null,
  trustedOrigin: string,
): boolean {
  if (frame === null || mainFrame === null) return false
  if (frame !== mainFrame || frame.detached === true) return false
  return originOf(frame.url) === trustedOrigin
}

/**
 * Registers IPC handlers through a single gate: sender check, payload
 * validation, response validation, and mapping of thrown errors to typed
 * results. Handlers never run for a rejected request.
 */
export function createIpcRegistry(options: IpcRegistryOptions): IpcRegistry {
  const { ipcMain, mainFrame, trustedOrigin, log } = options
  const registered: string[] = []

  return {
    channels: registered,
    handle<I, R, O>(channel: string, request: ZodType<I>, response: ZodType<O, R>, handler: Handler<I, R>) {
      if (registered.includes(channel)) throw new Error(`IPC channel registered twice: ${channel}`)
      registered.push(channel)

      ipcMain.handle(channel, async (event, ...args): Promise<ApiResult<O>> => {
        const frame = event.senderFrame
        if (!isTrustedSender(frame, mainFrame(), trustedOrigin)) {
          log.record('warn', 'ipc.rejected-sender', { channel, url: frame?.url ?? null })
          return fail('forbidden', 'Request rejected: unexpected sender')
        }
        if (args.length > 1) {
          log.record('warn', 'ipc.rejected-payload', { channel, reason: 'too many arguments' })
          return fail('validation', 'Request rejected: unexpected arguments')
        }
        const parsed = request.safeParse(args[0])
        if (!parsed.success) {
          log.record('warn', 'ipc.rejected-payload', { channel, issues: parsed.error.issues.length })
          return fail('validation', `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
        }
        // Ordering guarantee: everything up to the handler call runs synchronously, and Electron
        // dispatches a renderer's invokes in the order they were sent. So a handler has run (or
        // started) before the next request of the same renderer is handled; the renderer stores
        // rely on this when they subscribe to events and then request a snapshot. Do not add an
        // `await` before this call (tested in ipc-operations.test.ts).
        let value: R
        try {
          value = await handler(parsed.data, { sender: event.sender })
        } catch (error) {
          if (error instanceof UnsupportedPlatformError) return fail('unsupported_platform', error.message)
          if (error instanceof NotImplementedError) return fail('not_implemented', error.message)
          if (error instanceof NotFoundError) return fail('not_found', error.message)
          if (error instanceof ShuttingDownError) return fail('shutting_down', error.message)
          if (error instanceof UserError) return fail('rejected', error.message)
          log.record('error', 'ipc.handler-failed', {
            channel,
            message: error instanceof Error ? error.message : String(error),
          })
          return fail('internal', 'Internal error')
        }
        const checked = response.safeParse(value)
        if (!checked.success) {
          // Only issue locations are logged: the rejected value may contain secrets.
          log.record('error', 'ipc.invalid-response', {
            channel,
            paths: checked.error.issues.slice(0, 5).map((i) => i.path.join('.')),
          })
          return fail('internal', 'Internal error')
        }
        return ok(checked.data)
      })
    },
  }
}
