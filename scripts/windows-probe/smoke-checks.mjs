// Names of the checks `veydr --smoke-test` can report (src/main/app/smoke.ts), in report order.
// checks.mjs generates `electron-smoke-<check>` and `nsis-smoke-<check>` from them;
// test/unit/windows-probe-corpus.test.ts fails when smoke.ts adds or renames a check.
// `timeout` is reported only when the smoke test does not finish in time.

export const SMOKE_CHECKS = Object.freeze([
  'process-sandbox',
  'config-dir-writable',
  'platform',
  'ui-loaded',
  'preload-bridge',
  'renderer-isolation',
  'devtools-disabled',
  'timeout',
])

/** Checks smoke.ts runs only for a packaged build, so an unpackaged build never reports them. */
export const PACKAGED_ONLY_SMOKE_CHECKS = Object.freeze(['devtools-disabled'])

/** Reported only when the smoke test does not finish in time. */
export const ON_TIMEOUT_SMOKE_CHECKS = Object.freeze(['timeout'])
