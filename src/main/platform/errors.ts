/** Raised by every operation on an OS without a platform implementation. */
export class UnsupportedPlatformError extends Error {
  override readonly name = 'UnsupportedPlatformError'
  readonly code = 'unsupported_platform'

  constructor(
    readonly platform: string,
    readonly operation: string,
  ) {
    super(`${operation} is not supported on this platform (${platform})`)
  }
}

export type SpawnFailure =
  | 'executable-not-found'
  | 'not-executable'
  | 'cwd-missing'
  | 'cwd-not-directory'
  | 'cwd-inaccessible'
  | 'other'

/** A command could not be started; no process was created. `message` is meant for the user. */
export class SpawnError extends Error {
  override readonly name = 'SpawnError'

  constructor(
    readonly reason: SpawnFailure,
    message: string,
  ) {
    super(message)
  }
}

/** Raised by operations (platform or IPC) whose implementation lands in a later task group. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError'

  constructor(readonly operation: string) {
    super(`${operation} is not implemented yet`)
  }
}
