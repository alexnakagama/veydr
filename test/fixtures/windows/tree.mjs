// Windows process-tree fixture (add-windows-process-supervision design D7). Every process carries
// `--marker <id>` on its command line, so tests find it independently with Win32_Process, and
// writes <dir>/<role>.json ({"pid":…}) once it and its children are running. Processes then stay
// alive until they are ended.
//
//   node tree.mjs --marker <id> --dir <dir> [--role R] [--depth N] [--fanout N] [--ignore-break]
//                 [--orphan] [--first] [--sentinel <signals file>]
//
// --ignore-break  every process ignores Ctrl+Break and Ctrl+C (an uncooperative tree)
// --orphan        the root's child starts a detached grandchild and exits once it runs, leaving the
//                 grandchild without its parent
// --first         the root starts a detached child as its very first action and exits at once
// --sentinel      an unrelated process: it appends every console event it receives to the file
//
// Children are started as a command's tools usually start theirs: on the parent's console (no
// `windowsHide`, which would give each child a console of its own) and, unless detached, in Node's
// own job, which ends them with their parent. A detached child has no console and is outside it.
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const flag = (name) => argv.includes(`--${name}`)

/** Arguments for a child process of this tree, with `role` and the given extra flags. */
const childArgs = (role, extra) => [
  process.argv[1],
  '--marker',
  option('marker'),
  '--dir',
  option('dir'),
  '--role',
  role,
  ...(flag('ignore-break') ? ['--ignore-break'] : []),
  ...extra,
]

const start = (role, extra, detached) =>
  spawn(process.execPath, childArgs(role, extra), { detached, stdio: detached ? 'ignore' : ['ignore', 'inherit', 'inherit'] })

// The very first action, before anything else of the fixture runs.
if (flag('first')) {
  start(`${option('role') ?? 'root'}.0`, [], true)
  process.exit(0)
}

const { renameSync, writeFileSync, appendFileSync, existsSync } = await import('node:fs')
const { join } = await import('node:path')

const marker = option('marker')
const dir = option('dir')
const role = option('role') ?? 'root'
if (marker === undefined || dir === undefined) throw new Error('--marker and --dir are required')

const readyFile = (name) => join(dir, `${name}.json`)
const ready = () => {
  const file = readyFile(role)
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid }))
  renameSync(`${file}.tmp`, file)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const waitForReady = async (name) => {
  while (!existsSync(readyFile(name))) await sleep(20)
}

const signals = option('sentinel')
if (signals !== undefined) {
  for (const signal of ['SIGBREAK', 'SIGINT']) process.on(signal, () => appendFileSync(signals, `${signal}\n`))
} else if (flag('ignore-break')) {
  for (const signal of ['SIGBREAK', 'SIGINT']) process.on(signal, () => undefined)
}

// Alive until ended; never ends on its own within a test.
setInterval(() => undefined, 1 << 30)

if (flag('orphan') && role === 'root') {
  start(`${role}.0`, ['--orphan-parent'], false)
  await waitForReady(`${role}.0`)
} else if (flag('orphan-parent')) {
  start(`${role}.0`, [], true)
  await waitForReady(`${role}.0`)
  ready()
  process.exit(0)
} else {
  const depth = Number(option('depth') ?? '0')
  const fanout = Number(option('fanout') ?? '1')
  for (let i = 0; depth > 0 && i < fanout; i++) start(`${role}.${i}`, ['--depth', String(depth - 1), '--fanout', String(fanout)], false)
  for (let i = 0; depth > 0 && i < fanout; i++) await waitForReady(`${role}.${i}`)
}
ready()
