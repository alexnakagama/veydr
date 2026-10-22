import type { ZodType } from 'zod'
import { fail, ok, type ApiResult } from '../../shared/api'
import type { DiagnosticLog } from '../app/diagnostics'
import { UnsupportedPlatformError } from '../platform/errors'

/** The subset of a frame the sender check needs (Electron `WebFrameMain`). */
export interface SenderFrame {
  readonly url: string
  readonly detached?: boolean
}

/** The subset of `IpcMainInvokeEvent` the helper needs. */
export interface InvokeEvent {
  readonly senderFrame: SenderFrame | null
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

export type Handler<I, O> = (input: I) => O | Promise<O>

export interface IpcRegistry {
  handle<I, O>(channel: string, schema: ZodType<I>, handler: Handler<I, O>): void
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
 * validation, and mapping of thrown errors to typed results. Handlers never
 * run for a rejected request.
 */
export function createIpcRegistry(options: IpcRegistryOptions): IpcRegistry {
  const { ipcMain, mainFrame, trustedOrigin, log } = options
  const registered: string[] = []

  return {
    channels: registered,
    handle<I, O>(channel: string, schema: ZodType<I>, handler: Handler<I, O>) {
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
        const parsed = schema.safeParse(args[0])
        if (!parsed.success) {
          log.record('warn', 'ipc.rejected-payload', { channel, issues: parsed.error.issues.length })
          return fail('validation', `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
        }
        try {
          return ok(await handler(parsed.data))
        } catch (error) {
          if (error instanceof UnsupportedPlatformError) return fail('unsupported_platform', error.message)
          log.record('error', 'ipc.handler-failed', {
            channel,
            message: error instanceof Error ? error.message : String(error),
          })
          return fail('internal', 'Internal error')
        }
      })
    },
  }
}
