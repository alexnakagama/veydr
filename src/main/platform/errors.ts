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

/** Raised by Linux operations whose implementation lands in a later task group. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError'

  constructor(readonly operation: string) {
    super(`${operation} is not implemented yet`)
  }
}
