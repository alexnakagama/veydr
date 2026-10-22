import type { VeydrApi } from '../../shared/api'

declare global {
  interface Window {
    readonly veydr: VeydrApi
  }
}

export {}
