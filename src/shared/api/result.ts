export type ApiErrorCode =
  | 'validation'
  | 'forbidden'
  /** The request names something that does not exist (e.g. a removed command). */
  | 'not_found'
  | 'unsupported_platform'
  /** The operation is declared in the API contract but lands in a later task group. */
  | 'not_implemented'
  | 'internal'

export interface ApiError {
  readonly code: ApiErrorCode
  readonly message: string
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError }

export function ok<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

export function fail(code: ApiErrorCode, message: string): ApiResult<never> {
  return { ok: false, error: { code, message } }
}
