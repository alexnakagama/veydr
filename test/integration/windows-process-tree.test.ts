import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HELPER_PATH } from '../../scripts/build-windows-helper.mjs'

// The Windows process tree against real Windows processes (add-windows-process-supervision design D7).
// It needs Job Objects and the helper built by `node scripts/build-windows-helper.mjs`, which the
// `windows` CI job runs first. A missing helper fails these tests; it never skips them.

/** The control protocol version the helper must report (design D2). */
const PROTOCOL_VERSION = '1'

const runHelper = (...args: string[]) => spawnSync(HELPER_PATH, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })

describe.skipIf(process.platform !== 'win32')('[windows-only: Job Objects]', () => {
  it('has the built helper', () => {
    expect(existsSync(HELPER_PATH), `${HELPER_PATH} is missing: run node scripts/build-windows-helper.mjs`).toBe(true)
  })

  it('prints the protocol version', () => {
    const run = runHelper('version')
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe(PROTOCOL_VERSION)
    expect(run.stderr).toBe('')
  })

  it('refuses an unknown subcommand with a usage line and exit code 2', () => {
    for (const args of [[], ['frobnicate'], ['version', 'extra']]) {
      const run = runHelper(...args)
      expect(run.status, args.join(' ')).toBe(2)
      expect(run.stdout, args.join(' ')).toBe('')
      expect(run.stderr, args.join(' ')).toContain('usage: veydr-helper')
    }
  })

  // The scenarios below are implemented by the group that owns them (tasks.md); the tags keep
  // `npm run spec-coverage` at zero unmapped scenarios in the meantime.
  it.todo('[spec:process-supervision/children-and-grandchildren-stopped-on-windows] ends every process of the tree (group 3)')
  it.todo('[spec:process-supervision/orphaned-descendant-stopped-on-windows] ends an orphaned grandchild (group 3)')
  it.todo('[spec:process-supervision/descendant-started-immediately] keeps a child started as the first action in the job (group 3)')
  it.todo('[spec:process-supervision/uncooperative-process-on-windows] forcibly ends a tree that ignores Ctrl+Break (group 3)')
  it.todo('[spec:process-supervision/cooperative-process-on-windows] stops a tree that exits on Ctrl+Break gracefully (group 4)')
  it.todo('[spec:process-supervision/batch-file-command-stopped-gracefully] stops a batch-file command without the Terminate batch job prompt (group 4)')
  it.todo('[spec:process-supervision/veydr-ends-abnormally-on-windows] leaves no tree process when Veydr is killed (group 5)')
  it.todo('[spec:process-supervision/helper-ends-abnormally-on-windows] ends the tree when the helper is killed (group 5)')
  it.todo('[spec:process-supervision/reused-pid-on-windows] neither reports nor ends a process with a reused PID (group 5)')
  // Their tests land in other files in group 6, which removes these two todos.
  it.todo('[spec:process-supervision/windows-limitations-documented] documents the Windows limitations (group 6)')
  it.todo('[spec:process-supervision/windows-process-trees-verified-natively] runs the Windows process-tree tests on a Windows runner (group 6)')
})
