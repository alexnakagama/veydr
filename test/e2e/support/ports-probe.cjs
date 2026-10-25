'use strict'
// Test-only: loaded with `-r`. For the port-inspection E2E tests:
// - appends one line to `$VEYDR_TEST_PORT_READS` each time the main process reads /proc/net/tcp
//   (one per port listing), so a test can tell when the ports view polls;
// - simulates a listener owned by another user (root): reading the open files of a process whose
//   command line contains `restricted-listener` fails with EACCES, its /proc/<pid>/status reports
//   root's user IDs, and its sockets are listed with uid 0 in /proc/net/tcp{,6}.
// Nothing else changes.
const { appendFileSync, readdirSync, readFileSync, readlinkSync } = require('node:fs')
const promises = require('node:fs/promises')

const readsLog = process.env.VEYDR_TEST_PORT_READS

/** PIDs of the simulated other user's processes. */
function restrictedPids() {
  return readdirSync('/proc').filter((name) => {
    if (!/^\d+$/.test(name)) return false
    try {
      return readFileSync(`/proc/${name}/cmdline`, 'latin1').includes('restricted-listener')
    } catch {
      return false
    }
  })
}

/** Socket inodes the simulated other user's processes `pids` hold. */
function restrictedInodes(pids) {
  const inodes = new Set()
  for (const pid of pids) {
    let fds = []
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))
        if (match !== null) inodes.add(match[1])
      } catch {
        // Closed meanwhile.
      }
    }
  }
  return inodes
}

/** Rows of a socket table with the uid (field 8) of the given inodes (field 10) set to 0. */
function asRoot(text, inodes) {
  return text
    .split('\n')
    .map((line) => {
      const fields = line.trim().split(/\s+/)
      return /^\d+:$/.test(fields[0] ?? '') && inodes.has(fields[9]) ? line.replace(new RegExp(`\\s${fields[7]}(\\s+\\d+\\s+${fields[9]}\\s)`), ' 0$1') : line
    })
    .join('\n')
}

/** The simulated other user's processes, found when the listing read its socket tables. */
let restricted = []

const readFile = promises.readFile
promises.readFile = async function (path, ...rest) {
  const target = typeof path === 'string' ? path : ''
  if (readsLog !== undefined && target.endsWith('/net/tcp')) appendFileSync(readsLog, `${Date.now()}\n`)
  const content = await readFile.call(this, path, ...rest)
  if (/^\/proc\/net\/tcp6?$/.test(target)) {
    // The listing reads the tables before any process file (and both tables before either is used).
    restricted = restrictedPids()
    const text = asRoot(content.toString(), restrictedInodes(restricted))
    return typeof content === 'string' ? text : Buffer.from(text)
  }
  const status = /^\/proc\/(\d+)\/status$/.exec(target)
  if (status !== null && restricted.includes(status[1])) {
    const text = content.toString().replace(/^(Uid|Gid):.*$/gm, '$1:\t0\t0\t0\t0')
    return typeof content === 'string' ? text : Buffer.from(text)
  }
  return content
}

const readdir = promises.readdir
promises.readdir = function (path, ...rest) {
  const match = typeof path === 'string' ? /^\/proc\/(\d+)\/fd$/.exec(path) : null
  if (match !== null) {
    let cmdline = ''
    try {
      cmdline = readFileSync(`/proc/${match[1]}/cmdline`, 'latin1')
    } catch {
      // Gone: let the real call report it.
    }
    if (cmdline.includes('restricted-listener')) {
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), { code: 'EACCES', errno: -13, syscall: 'scandir', path }))
    }
  }
  return readdir.call(this, path, ...rest)
}
