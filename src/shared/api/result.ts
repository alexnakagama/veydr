export type ApiErrorCode = 'validation' | 'forbidden' | 'unsupported_platform' | 'internal'

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
