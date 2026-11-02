#!/usr/bin/env node
// The installer probes (task 7.2, design D3): electron-builder builds a per-user, one-click NSIS
// installer from command-line options, with electron-builder.yml unchanged; the installer installs
// silently, the installed app runs `--smoke-test`, and a silent uninstall removes it. Nothing here
// needs a window, and the job's VM is discarded, so a failed uninstall leaves nothing to clean up.
//
//   node scripts/windows-probe/nsis.mjs --user admin
//
// is started by launch-detached.mjs and writes the result lines to stdout. The workflow builds the app
// and downloads Electron first. Exit codes: 0 written, 1 failure, including a smoke report with a check
// checks.mjs does not know, 2 usage error.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DriverUsageError, driverMain, isEntryPoint, noAnswer, parseDriverArgs, runDriver, runProgram } from './driver.mjs'
import { describeExit } from './helper-build.mjs'
import { placeholderIds } from './placeholder.mjs'
import { appEnv, expectedExitCode, launchAnswer, outputTail, reportAnswers, runSmoke, smokeAnswers, smokeData, smokeIds } from './smoke-run.mjs'

const AREA = 'nsis'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUILDER = fileURLToPath(new URL('../../node_modules/electron-builder/cli.js', import.meta.url))
const BUILDER_CONFIG = join(ROOT, 'electron-builder.yml')
const INSTALLER = 'veydr-probe-setup.exe'
/** Where a per-user one-click install goes: electron-builder names the directory after package.json's `name`. */
export const INSTALL_DIRECTORY = 'veydr'
export const BUILD_MS = 900_000
export const INSTALL_MS = 180_000
export const UNINSTALL_MS = 180_000
/** The uninstaller copies itself to a temporary file and returns, so the directory goes after it exits. */
const UNINSTALL_GONE_MS = 120_000
const GONE_POLL_MS = 1_000

/** electron-builder's command line. A run writes only to `outputDir`, and starts no app when the installer finishes. */
export function builderArgs(outputDir) {
  return [
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    `-c.directories.output=${outputDir}`,
    '-c.nsis.oneClick=true',
    '-c.nsis.perMachine=false',
    '-c.nsis.runAfterFinish=false',
    '-c.nsis.artifactName=veydr-probe-setup.${ext}',
  ]
}

/**
 * The environment for electron-builder: unlike a launch of the app it keeps the ELECTRON_* settings
 * the build tools read, and it holds no signing or publishing credentials, which a probe never needs.
 */
export function builderEnv(env = process.env) {
  const dropped = /^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|GH_TOKEN|GITHUB_TOKEN|CSC_.*|WIN_CSC_.*)$/i
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !dropped.test(name))), CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
}

/** nsis-build. */
export function nsisBuildAnswer({ run, installerSize, configChanged }, timeoutMs = BUILD_MS) {
  const unanswered = noAnswer(run, timeoutMs)
  if (unanswered !== undefined) return unanswered
  if (configChanged) return { answer: 'no', detail: 'electron-builder.yml changed during the build' }
  if (run.code !== 0) return { answer: 'no', detail: `electron-builder ${describeExit(run)}: ${outputTail(`${run.stdout} ${run.stderr}`)}` }
  if (installerSize === undefined) return { answer: 'no', detail: `electron-builder ${describeExit(run)} but built no ${INSTALLER}: ${outputTail(run.stdout)}` }
  return { answer: 'yes', detail: '' }
}

/** The installed app and its uninstaller among a directory's file names; undefined if not exactly one of a kind. */
export function installedPrograms(names) {
  const programs = names.filter((name) => /\.exe$/i.test(name))
  const uninstallers = programs.filter((name) => /^uninstall /i.test(name))
  const apps = programs.filter((name) => !uninstallers.includes(name))
  return { app: apps.length === 1 ? apps[0] : undefined, uninstaller: uninstallers.length === 1 ? uninstallers[0] : undefined }
}

/** nsis-install, from each step's outcome. A step that was not reached is undefined. */
export function installAnswer({ install, directory, found = [], programs, smoke, uninstall, left }) {
  const installStopped = noAnswer(install, INSTALL_MS)
  if (installStopped !== undefined) return installStopped
  if (install.code !== 0) return { answer: 'no', detail: `the silent install ${describeExit(install)}: ${outputTail(`${install.stdout} ${install.stderr}`)}` }
  if (directory === undefined) return { answer: 'no', detail: `the silent install exited with 0, but Programs holds no ${INSTALL_DIRECTORY} directory, only: ${found.join(', ') || 'nothing'}` }
  if (programs?.app === undefined) return { answer: 'no', detail: 'the install directory does not hold exactly one program' }
  if (smoke === undefined) return { answer: null, detail: 'the installed app was not run' }
  const launch = launchAnswer(smoke)
  // The question asks for a report readable on a pipe, so this is a `no` even if the rest worked.
  if (launch.answer !== 'yes') return { ...launch, detail: `the install worked, and the uninstall was ${uninstall === undefined || uninstall.code !== 0 || left ? 'not clean' : 'clean'}, but the installed app gave no readable report: ${launch.detail}` }
  if (smoke.run.code !== expectedExitCode(smoke.report)) return { answer: 'no', detail: `the installed app ${describeExit(smoke.run)}, but its report says ${String(smoke.report?.result)}` }
  if (programs.uninstaller === undefined) return { answer: 'no', detail: 'the install directory does not hold exactly one uninstaller' }
  if (uninstall === undefined) return { answer: null, detail: 'the uninstaller was not run' }
  const uninstallStopped = noAnswer(uninstall, UNINSTALL_MS)
  if (uninstallStopped !== undefined) return uninstallStopped
  if (uninstall.code !== 0) return { answer: 'no', detail: `the silent uninstall ${describeExit(uninstall)}: ${outputTail(`${uninstall.stdout} ${uninstall.stderr}`)}` }
  if (left) return { answer: 'no', detail: `the install directory is still there ${UNINSTALL_GONE_MS / 1000} s after the silent uninstall` }
  return { answer: 'yes', detail: '' }
}

/** Every answer of the area by ID, and the report's checks that have no ID. */
export function nsisAnswers({ ids, build, installed }) {
  const smoke = installed.smoke ?? { run: { code: null, signal: null, stdout: '', stderr: '' }, problem: installed.reason ?? 'the installed app was not run', reportVia: null }
  const { answers, unknown } = smokeAnswers({ prefix: AREA, ids: smokeIds(ids, AREA), smoke, packaged: true })
  const install = installed.reason === undefined ? installAnswer(installed) : { answer: null, detail: installed.reason }
  return {
    unknown,
    answers: {
      ...answers,
      'nsis-build': { ...nsisBuildAnswer(build), data: { code: build.run.code, signal: build.run.signal, installerSize: build.installerSize ?? null, oneClick: true, perMachine: false } },
      'nsis-install': {
        ...install,
        data: {
          installCode: installed.install?.code ?? null,
          installDirectory: installed.directory ?? null,
          programs: installed.programs ?? null,
          ...(installed.smoke === undefined ? {} : { smoke: smokeData(installed.smoke) }),
          uninstallCode: installed.uninstall?.code ?? null,
          directoryLeft: installed.left ?? null,
        },
      },
    },
  }
}

const hashOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

async function build(outputDir) {
  const before = hashOf(BUILDER_CONFIG)
  // No signing identity is looked for: the probe's installer is unsigned, and never leaves the job.
  const run = await runProgram(process.execPath, [BUILDER, ...builderArgs(outputDir)], { timeoutMs: BUILD_MS, cwd: ROOT, env: builderEnv() })
  const installer = join(outputDir, INSTALLER)
  return { run, installer, installerSize: existsSync(installer) ? statSync(installer).size : undefined, configChanged: hashOf(BUILDER_CONFIG) !== before }
}

async function waitUntilGone(directory) {
  const deadline = Date.now() + UNINSTALL_GONE_MS
  while (existsSync(directory) && Date.now() < deadline) await sleep(GONE_POLL_MS)
  return existsSync(directory)
}

/** The steps nsisAnswers reads. */
async function installAndRun(installer, dir) {
  if (process.env.LOCALAPPDATA === undefined) return { reason: 'LOCALAPPDATA is not set, so the install directory cannot be found' }
  const programsRoot = join(process.env.LOCALAPPDATA, 'Programs')
  const target = join(programsRoot, INSTALL_DIRECTORY)
  if (existsSync(target)) return { reason: `${target} exists before the install` }
  const install = await runProgram(installer, ['/S'], { timeoutMs: INSTALL_MS, env: appEnv() })
  const directory = existsSync(target) ? target : undefined
  if (install.code !== 0 || directory === undefined) return { install, directory, found: existsSync(programsRoot) ? readdirSync(programsRoot) : [] }
  const programs = installedPrograms(readdirSync(directory))
  const smoke = programs.app === undefined ? undefined : await runSmoke(join(directory, programs.app), ['--smoke-test'], { dir })
  if (programs.uninstaller === undefined) return { install, directory, programs, smoke }
  const uninstall = await runProgram(join(directory, programs.uninstaller), ['/S'], { timeoutMs: UNINSTALL_MS, env: appEnv() })
  return { install, directory, programs, smoke, uninstall, left: await waitUntilGone(directory) }
}

async function measureNsis() {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-nsis-'))
  try {
    const outcome = await build(join(dir, 'dist'))
    const built = outcome.run.code === 0 && outcome.installerSize !== undefined
    return { build: outcome, installed: built ? await installAndRun(outcome.installer, dir) : { reason: 'no installer was built' } }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests), but for `measureArea`. */
export async function runNsis(args, { measureArea = measureNsis, ...options } = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (positional.length > 0) throw new DriverUsageError(`expected no positional arguments, got ${JSON.stringify(positional)}`)
  const ids = placeholderIds(AREA, user)
  await runDriver({
    ...options,
    area: AREA,
    user,
    ids,
    unavailable,
    probe: async (report) => {
      let measured
      try {
        measured = await measureArea()
      } catch (error) {
        const detail = `the probe failed: ${error instanceof Error ? error.message : String(error)}`
        reportAnswers(report, ids, { answers: Object.fromEntries(ids.map((id) => [id, { answer: null, detail, data: {} }])) })
        return
      }
      reportAnswers(report, ids, nsisAnswers({ ids, ...measured }))
    },
  })
}

if (isEntryPoint(import.meta.url)) driverMain('nsis.mjs', runNsis)
