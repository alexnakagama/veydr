/** IPC channel per exposed operation. Preload and main both use this table. */
export const channels = {
  app: {
    getInfo: 'app:getInfo',
  },
} as const

/**
 * Operation groups and names the preload bridge may expose. The E2E API
 * enumeration test compares `window.veydr` against this table.
 */
export const declaredOperations = {
  app: ['getInfo'],
} as const satisfies Record<string, readonly string[]>
