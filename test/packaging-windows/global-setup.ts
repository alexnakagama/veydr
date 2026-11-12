import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { distDir, installerName, installRecordPath, startInstallRecord, unpackedDir, version } from './support'

// Global setup of the `packaging-windows` project (add-windows-packaging design D3, task 3.1): starts
// the Windows install record, test-results/windows-install/steps.jsonl, with the SHA-256 and the
// name of the installer in dist\, replacing the record of an earlier run.
//
// It runs whenever the Windows build output exists (`dist\win-unpacked`, which `npm run dist:windows`
// writes), and then fails if the installer of package.json's version is missing. Without that output
// (any system before `dist:windows`, or Linux) there is nothing to record: the suites skip on other
// systems, and on Windows they fail in `requirePackages`, and so does `recordStep`.

/** Starts the record for the installer of `packageVersion` in `dist`; returns the first line's `installer` value. */
export async function startRecordFor({ dist = distDir, packageVersion = version, record = installRecordPath }: { dist?: string; packageVersion?: string; record?: string } = {}): Promise<string> {
  const installer = join(dist, installerName(packageVersion))
  if (!existsSync(installer)) throw new Error(`${installer} is missing: run \`npm run dist:windows\` (or \`npm run test:packaging:windows\`) first`)
  return await startInstallRecord(installer, record)
}

export default async function setup(): Promise<void> {
  if (!existsSync(unpackedDir)) return
  const line = await startRecordFor()
  console.log(`windows install record: ${installRecordPath}: ${line}`)
}
