'use strict'
// Loaded into an Electron main process with `-r` by the single-instance E2E
// test. Records every Node `fs` call (callback, sync, and promise APIs) that
// names a path inside VEYDR_FS_GUARD_DIR to the JSONL file in
// VEYDR_FS_GUARD_LOG. Chromium's own (C++) file access is not visible here;
// Veydr's configuration code only uses Node `fs`.
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const watched = process.env.VEYDR_FS_GUARD_DIR
const logPath = process.env.VEYDR_FS_GUARD_LOG
if (watched && logPath) {
  const appendFileSync = fs.appendFileSync
  const root = path.resolve(watched)
  const ownLog = path.resolve(logPath)

  // `appendFileSync` calls other fs functions internally; those calls are the guard's own.
  let recording = false
  const record = (entry) => {
    recording = true
    try {
      appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
    } catch {
      // The guard must never change app behaviour.
    } finally {
      recording = false
    }
  }

  const asPath = (value) => {
    try {
      if (typeof value === 'string') return path.resolve(value)
      if (Buffer.isBuffer(value)) return path.resolve(value.toString())
      if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value)
    } catch {
      // Not a path.
    }
    return null
  }
  const inside = (p) => p !== null && p !== ownLog && (p === root || p.startsWith(`${root}${path.sep}`))

  const wrap = (owner, name, label) => {
    const original = owner[name]
    if (typeof original !== 'function') return
    const wrapped = function guardedFs(...args) {
      // Two-path operations (rename, copyFile, link, symlink, cp) name both paths first.
      for (const candidate of recording ? [] : args.slice(0, 2).map(asPath)) {
        if (inside(candidate)) {
          record({ api: label, path: candidate })
          break
        }
      }
      return original.apply(this, args)
    }
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original))
    owner[name] = wrapped
  }

  const names = [
    'access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'exists', 'lchown', 'link', 'lstat', 'lutimes',
    'mkdir', 'open', 'openAsBlob', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm',
    'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'watchFile', 'writeFile',
    'createReadStream', 'createWriteStream', 'glob',
  ]
  for (const name of names) {
    wrap(fs, name, `fs.${name}`)
    wrap(fs, `${name}Sync`, `fs.${name}Sync`)
    wrap(fs.promises, name, `fs.promises.${name}`)
  }

  record({ api: 'guard', path: null, kind: 'installed' })
}
