import type { AppInfo } from './app'
import type { ApiResult } from './result'

export * from './app'
export * from './channels'
export * from './result'

export interface VeydrApi {
  readonly app: {
    getInfo(): Promise<ApiResult<AppInfo>>
  }
}
