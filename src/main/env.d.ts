/// <reference types="electron-vite/node" />

/** True only in the `--mode probe` test build (see electron.vite.config.ts). */
declare const __VEYDR_PROBE__: boolean
/** True only in `electron-vite dev` builds; false (and dead-code eliminated) otherwise. */
declare const __VEYDR_DEV__: boolean
