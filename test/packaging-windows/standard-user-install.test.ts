import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { INSTALLER_ID, SMOKE_ID, STEP_IDS } from '../../scripts/windows-probe/installer-standard-user.mjs'
import { accountExists, loggable, readResultLines, removeLeftoverAccount, runLauncher, STANDARD_USER_ACCOUNT } from '../support/standard-user'
import { type InstallRecordLine, installerPath, installRecordPath, recordStep, requirePackages, standardUserStepPassed as stepPassed } from './support'

// The installer run by a temporary standard user through W0's launcher (add-windows-packaging
// design D5, task 4.3): standard-user.ps1 creates the local account veydr-probe, copies the
// installer for it, runs installer-standard-user.mjs as that account, and removes the account
// whatever happens. It changes the machine's accounts, so it runs only in CI, where every failure of
// the launcher fails the test: a standard user that cannot be set up is a failure, not a skip
// (quality-gates/windows-installer-tested-as-a-standard-user). Every step is appended to the install
// record. test/support/sequencer.ts runs this file after installer.test.ts, whose administrator's
// smoke test the rule for this smoke step reads.

/** Set by GitHub Actions; the suite creates an account only there. */
const notCi = process.env['CI'] !== 'true'

/** The driver's own limit (-Timeout): an install, a smoke test and its control, and an uninstall. */
const DRIVER_TIMEOUT_S = 1_200
/** Beyond every wait of the launcher (copies, two readability checks, the driver, the unavailable fallback). */
const LAUNCHER_TIMEOUT_MS = 1_560_000

const CONTEXT_IDS = ['ctx-no-console', 'ctx-job', 'ctx-standard-user']

/** The install record's lines. */
const readRecord = (): InstallRecordLine[] =>
  readFileSync(installRecordPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as InstallRecordLine)

/** The record's step name for a result line: `standard-user/<step>`, from `install-std-<step>`. */
const stepName = (id: string): string => `standard-user/${id.replace(/^install-std-/, '')}`

describe.skipIf(process.platform !== 'win32')('[windows-only: Windows accounts] installation as a standard user', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(notCi)(
    '[spec:desktop-shell/silent-installation-as-a-standard-user] [spec:quality-gates/windows-installer-tested-as-a-standard-user] installs silently below a standard user\'s own profile, exercises the installed helper and the app, and uninstalls, as that user',
    { timeout: LAUNCHER_TIMEOUT_MS + 180_000 },
    async () => {
      requirePackages()
      // The installer the record names, which the standard user's copy must be.
      const [first] = readRecord()
      const recorded = (first?.detail as { installer?: unknown } | undefined)?.installer
      if (first?.step !== 'installer' || typeof recorded !== 'string') throw new Error(`${installRecordPath} does not start with the installer's line`)
      // A run that started over an account left by an earlier step would test nothing of its own.
      if (accountExists()) throw new Error(`the account ${STANDARD_USER_ACCOUNT} exists before the run`)

      const dir = mkdtempSync(join(tmpdir(), 'veydr-install-std-'))
      dirs.push(dir)
      // The launcher appends to an existing results file only.
      const results = join(dir, 'results.jsonl')
      writeFileSync(results, '')

      let launched: Awaited<ReturnType<typeof runLauncher>> | undefined
      let launchError: unknown
      try {
        launched = await runLauncher(['-Results', results, '-Timeout', String(DRIVER_TIMEOUT_S), '-Driver', 'installer-standard-user.mjs', '-Installer', installerPath], LAUNCHER_TIMEOUT_MS)
      } catch (error) {
        launchError = error
      }
      // The launcher removes the account itself; one it left is removed here, and the test fails.
      try {
        removeLeftoverAccount(launchError)
        recordStep('standard-user/account-removed', true, { account: STANDARD_USER_ACCOUNT })
      } catch (error) {
        recordStep('standard-user/account-removed', false, { error: (error instanceof Error ? error.message : String(error)).slice(0, 4000) })
        throw error
      }
      if (launched === undefined) throw launchError
      console.info(`standard-user.ps1 exited with ${String(launched.code)}:\n${loggable(launched.stdout)}\n${loggable(launched.stderr)}`)
      // The log shows the account created and removed (task 4.3).
      expect(launched.stdout).toContain(`standard-user.ps1: created the account ${STANDARD_USER_ACCOUNT}`)
      expect(launched.stdout).toContain(`standard-user.ps1: removed the account ${STANDARD_USER_ACCOUNT}`)

      const lines = readResultLines(results)
      // The standard user could not be created or used: the driver answered every line with the reason.
      const unavailable = lines.find((line) => line.data['unavailable'] === true)
      if (unavailable !== undefined) {
        recordStep('standard-user/account', false, { unavailable: loggable(unavailable.detail).slice(0, 4000) })
        throw new Error(loggable(`the standard user was unavailable: ${unavailable.detail}`))
      }

      // Recorded before anything is asserted, so the record shows every step the driver reported.
      const record = readRecord()
      const byId = new Map(lines.map((line) => [line.id, line]))
      const control = byId.get('ctx-standard-user')
      recordStep('standard-user/account', control?.answer === 'yes', { control: control?.data ?? null })
      for (const id of STEP_IDS) {
        const line = byId.get(id)
        recordStep(stepName(id), line !== undefined && stepPassed(line, record), line === undefined ? { missing: true } : { answer: line.answer, detail: line.detail.slice(0, 4000), data: line.data })
      }
      if (launched.code !== 0) throw new Error(`standard-user.ps1 failed (exit code ${String(launched.code)}): ${loggable(launched.stderr)}`)

      expect(lines.map((line) => line.id)).toEqual([...CONTEXT_IDS, ...STEP_IDS])
      // The control: the driver ran with a token outside Administrators, so a pass is not an administrator's.
      expect(control, JSON.stringify(control)).toMatchObject({ answer: 'yes', data: { administrators: 'absent', elevated: false, hkcu: 'loaded' } })
      // The installer the standard user installed is the one the record names, and so the one uploaded.
      expect(byId.get(INSTALLER_ID), JSON.stringify(byId.get(INSTALLER_ID))).toMatchObject({ answer: 'yes', data: { installer: recorded } })
      for (const id of STEP_IDS) {
        const line = byId.get(id)
        expect(line !== undefined && stepPassed(line, record), `${id}: ${JSON.stringify(line)}`).toBe(true)
      }
      // Which smoke case the runner showed (recorded below group 4 of tasks.md).
      const smoke = byId.get(SMOKE_ID)
      console.info(`standard user's smoke step: ${String(smoke?.data['smokeCase'])}; control: ${JSON.stringify(smoke?.data['control'])}`)
      expect(accountExists()).toBe(false)
    },
  )
})
