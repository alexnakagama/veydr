#!/usr/bin/env node
// One process of a probe's process tree. It runs the spec in the JSON file named on its command line:
//
//   { dir, name, waitFor?, children?: [spec...], exitAfterReady?, signals?, detached?, via? }
//
// It waits for the file `waitFor`, starts `children` with child_process.spawn, as Veydr starts
// commands, waits for them to be ready, and writes <dir>/<name>.ready with its PID and theirs. It then
// idles until something stops it or WORKER_LIFETIME_MS has passed; with `exitAfterReady` it exits
// instead, leaving a `detached` child as an orphan: a child that is not detached would end with it,
// since libuv's job for its children has JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. With `signals`, SIGBREAK
// and SIGINT write a marker file and end it with 0. A child with `via: 'cmd'` runs under cmd.exe, so
// its parent's child is cmd.exe, whose own children libuv's job does not hold.
// A failure is written to <dir>/<name>.error; the exit code is then 1.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER, WORKER_LIFETIME_MS, errorFile, markerFile, readyFile, specFile, workerCommand, writeAtomic } from './tree-files.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForFile(file) {
  while (!existsSync(file)) await sleep(20)
}

function start(child) {
  const file = specFile(child.dir, child.name)
  writeAtomic(file, JSON.stringify(child))
  const options = { detached: child.detached === true, windowsHide: true, stdio: 'ignore' }
  if (child.via !== 'cmd') return spawn(process.execPath, [WORKER, file], options)
  const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  return spawn(cmd, ['/d', '/s', '/c', `"${workerCommand(file)}"`], { ...options, windowsVerbatimArguments: true })
}

async function run(spec) {
  if (spec.signals === true) {
    for (const [signal, name] of [['SIGBREAK', 'break'], ['SIGINT', 'int']]) {
      process.on(signal, () => {
        writeAtomic(markerFile(spec.dir, spec.name, name), String(process.pid))
        process.exit(0)
      })
    }
  }
  if (spec.waitFor !== undefined) await waitForFile(spec.waitFor)
  const children = {}
  for (const child of spec.children ?? []) {
    const started = start({ ...child, dir: spec.dir })
    await new Promise((resolve, reject) => {
      started.once('spawn', resolve)
      started.once('error', reject)
    })
    children[child.name] = started.pid
    await waitForFile(readyFile(spec.dir, child.name))
  }
  writeAtomic(readyFile(spec.dir, spec.name), JSON.stringify({ pid: process.pid, children }))
  if (spec.exitAfterReady === true) process.exit(0)
}

// The timer also keeps the process alive once run() has finished.
setTimeout(() => process.exit(3), WORKER_LIFETIME_MS)
const spec = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'))
run(spec).catch((error) => {
  writeAtomic(errorFile(spec.dir, spec.name), error instanceof Error ? error.message : String(error))
  process.exit(1)
})
