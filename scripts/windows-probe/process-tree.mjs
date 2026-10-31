#!/usr/bin/env node
// The process-tree probes (tasks 4.1–4.3, design D3): how a tree of processes started with
// child_process.spawn can be stopped, from a parent without a console. The driver builds trees of
// tree-worker.mjs, stops them, and reports what is still running. process-tree.ps1 reaches the Win32
// APIs; two copies run, because one attaches to children's consoles and must swallow their events
// (`console`), and the other starts processes, which must not inherit that (`main`).
//
//   node scripts/windows-probe/process-tree.mjs --user admin|standard [--unavailable <reason>]
//
// is started by launch-detached.mjs and writes the result lines to stdout. Exit codes: 0 written,
// 1 failure, 2 usage error.
//
// What a tree of Node processes does, which the results must be read with: libuv puts a child in a
// job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE held by its parent, so a Node process that ends takes its
// non-detached children with it. That is why the orphan is started `detached`, and why
// pt-parent-exit-* also measures a leader that is cmd.exe, which holds no such job.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DriverUsageError, driverMain, isEntryPoint, jobLimitNames, parseDriverArgs, runDriver, runProgram, windowsPowerShell } from './driver.mjs'
import { placeholderIds } from './placeholder.mjs'
import { WORKER, errorFile, markerFile, readyFile, specFile, workerCommand, writeAtomic } from './tree-files.mjs'

const AREA = 'process-tree'

/** Add-Type compiles the helper's C# first, which takes seconds, longer on a busy runner. */
const HELPER_START_MS = 120_000
const REQUEST_MS = 30_000
const WORKER_READY_MS = 60_000
/** A graceful stop must finish within this (design D3). */
const GRACEFUL_MS = 5_000
/** How long a stopped process may take to go, and how long a survivor is watched. */
const STOP_MS = 5_000
const SETTLE_MS = 3_000
const REUSE_MAX_PROCESSES = 1_000
const REUSE_MAX_MS = 60_000
const POLL_MS = 50

const CTRL_C_EVENT = 0
const CTRL_BREAK_EVENT = 1
const ERROR_ACCESS_DENIED = 5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (error) => (error instanceof Error ? error.message : String(error))
const system32 = (file) => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', file)

// ---------------------------------------------------------------------------------------------
// The answers, from what was measured

/**
 * The processes of `members` ({ name, pid, created }) still running in `rows` (the helper's inspect).
 * An unreadable process throws, unless `tolerate`: it then does not count, for callers that report it.
 */
export function survivors(members, rows, { tolerate = false } = {}) {
  const byPid = new Map(rows.map((row) => [row.Pid, row]))
  return members.filter((member) => {
    const row = byPid.get(member.pid)
    if (row === undefined) throw new Error(`no state for PID ${member.pid}`)
    if (row.Error !== null && row.Error !== undefined) {
      if (tolerate) return false
      throw new Error(`cannot read PID ${member.pid}: ${row.Error}`)
    }
    // A different creation time is another process that got the PID.
    return row.Running === true && row.Created === member.created
  })
}

/** `root` and its descendants in a process snapshot, following parent links. */
export function descendantsOf(processes, root) {
  const found = [root]
  for (let i = 0; i < found.length; i++) {
    for (const entry of processes) {
      if (entry.Parent === found[i] && !found.includes(entry.Pid)) found.push(entry.Pid)
    }
  }
  return found
}

const names = (members) => members.map((m) => m.name).join(', ')

/** Whether stopping everything worked: yes if nothing of `members` is left. */
export function allEndedAnswer(members, left, action) {
  return left.length === 0 ? { answer: 'yes', detail: '' } : { answer: 'no', detail: `still running after ${action}: ${names(left)}` }
}

/** pt-libuv-job: `ownJob` is the helper's own job, which is libuv's, since the driver started it attached. */
export function libuvJobAnswer({ childInJob, driverPid, childPid, ownJob }) {
  if (!childInJob) return { answer: 'no', detail: 'IsProcessInJob reports the child in no job' }
  if (ownJob.Pids === null || ownJob.Pids === undefined) {
    return { answer: null, detail: `the child is in a job, but the job's processes could not be listed to tell it from the runner's job: ${String(ownJob.PidsError ?? 'the helper is in no job')}` }
  }
  if (!ownJob.Pids.includes(childPid)) return { answer: 'no', detail: 'the child is in a job, but not in the job of the driver\'s other children' }
  if (ownJob.Pids.includes(driverPid)) return { answer: 'no', detail: 'the driver is in the same job, so it is not a job of the children alone' }
  return { answer: 'yes', detail: '' }
}

/** pt-ctrl-break-attach-*: the marker written, the tree gone in time, and the helper alive. */
export function gracefulAnswer({ send, marker, left, helperAlive, driverEvents, unknown = [] }) {
  const problems = []
  if (!send.Attached) problems.push(`AttachConsole failed with error ${send.AttachError}`)
  else if (!send.Sent) problems.push(`GenerateConsoleCtrlEvent failed with error ${send.SendError}`)
  if (!marker) problems.push('the SIGBREAK handler wrote no marker')
  if (left.length > 0) problems.push(`still running after ${GRACEFUL_MS / 1000} s: ${names(left)}`)
  if (!helperAlive) problems.push('the helper did not survive the event')
  if (driverEvents > 0) problems.push(`the driver received ${driverEvents} console events`)
  if (problems.length > 0) return { answer: 'no', detail: problems.join('; ') }
  // Nothing went wrong that can be seen, but a process that cannot be read may still run.
  return unknown.length === 0 ? { answer: 'yes', detail: '' } : { answer: null, detail: `could not tell whether these ended: ${names(unknown)}` }
}

/** pt-ctrl-c: only meaningful if the same event reaches a child outside a new process group. */
export function ctrlCAnswer({ baselineMarker, groupMarker, send }) {
  if (!send.Attached || !send.Sent) return { answer: null, detail: `the event could not be sent to the new process group: attach error ${send.AttachError}, send error ${send.SendError}` }
  if (!baselineMarker) return { answer: null, detail: 'Ctrl+C did not reach a child outside a new process group either, so the result says nothing' }
  return groupMarker ? { answer: 'no', detail: 'the process in a new process group received Ctrl+C' } : { answer: 'yes', detail: '' }
}

/** pt-console-window: visibility means something only on a visible window station. */
export function consoleWindowAnswer({ station, hidden, shown }) {
  if (!station.Visible) return { answer: null, detail: `the session has no desktop: window station ${String(station.Name)} is not visible` }
  if (!hidden.Attached) return { answer: null, detail: `could not attach to the child's console: error ${hidden.AttachError}` }
  // The control: a window that could be seen at all, or "not visible" says nothing.
  if (!shown.Attached || !shown.Visible) return { answer: null, detail: `a child without windowsHide has no visible console window either (attach error ${shown.AttachError}), so the session shows no windows` }
  return hidden.Visible ? { answer: 'no', detail: 'the child\'s console window is visible' } : { answer: 'yes', detail: '' }
}

/** pt-identity-reuse. */
export function reuseAnswer(reuse) {
  if (reuse.ReusedPid === null || reuse.ReusedPid === undefined) {
    return { answer: null, detail: `no PID recurred in ${reuse.Spawned} processes and ${reuse.ElapsedMs} ms` }
  }
  return reuse.FirstCreated !== reuse.SecondCreated ? { answer: 'yes', detail: '' } : { answer: 'no', detail: `PID ${reuse.ReusedPid} recurred with the same creation time` }
}

// ---------------------------------------------------------------------------------------------
// The helper

/** A running process-tree.ps1. */
export class Helper {
  #child
  #pending = new Map()
  #nextId = 1
  #closed
  #stderr = ''

  constructor(child, lines, onClose) {
    this.#child = child
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-500)
    })
    child.stdin.on('error', () => {})
    lines.on('line', (line) => this.#reply(line))
    onClose((why) => {
      this.#closed = `${why}${this.#stderr.trim() === '' ? '' : `; stderr ${JSON.stringify(this.#stderr.trim())}`}`
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer)
        reject(new Error(this.#closed))
      }
      this.#pending.clear()
    })
  }

  get alive() {
    return this.#closed === undefined
  }

  #reply(line) {
    let reply
    try {
      reply = JSON.parse(line)
    } catch {
      return
    }
    const waiting = this.#pending.get(reply.id)
    if (waiting === undefined) return
    this.#pending.delete(reply.id)
    clearTimeout(waiting.timer)
    if (reply.ok === true) waiting.resolve(reply.result)
    else waiting.reject(Object.assign(new Error(String(reply.error)), { code: reply.code }))
  }

  /** Sends one request and resolves with its result; rejects with the error, `code` being a Win32 error. */
  request(op, args = {}, timeoutMs = REQUEST_MS) {
    if (this.#closed !== undefined) return Promise.reject(new Error(this.#closed))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`the helper did not answer ${op} within ${timeoutMs / 1000} s`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#child.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`)
    })
  }

  async alivePing() {
    try {
      await this.request('ping')
      return true
    } catch {
      return false
    }
  }

  /** Ends the helper: closing stdin ends its loop; one that does not react is killed. */
  close() {
    if (this.#closed !== undefined) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#child.kill(), 5_000)
      this.#child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      this.#child.stdin.end()
    })
  }
}

function spawnHelper() {
  const script = fileURLToPath(new URL('./process-tree.ps1', import.meta.url))
  // Attached, not detached: Windows PowerShell 5.1 started detached does not run a script (context.ps1).
  return spawn(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Starts the helper and waits for its first line. `start` returns the child process (tests). */
export function startHelper({ start = spawnHelper, timeoutMs = HELPER_START_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = start()
    const lines = createInterface({ input: child.stdout })
    const closed = []
    let closeReason
    const onClose = (listener) => {
      if (closeReason !== undefined) listener(closeReason)
      else closed.push(listener)
    }
    const close = (why) => {
      if (closeReason !== undefined) return
      closeReason = why
      for (const listener of closed) listener(why)
    }
    const helper = new Helper(child, lines, onClose)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`the helper did not start within ${timeoutMs / 1000} s`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      close(`the helper could not start: ${error.message}`)
      reject(new Error(`the helper could not start: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const why = `the helper exited with ${signal ?? String(code)}`
      close(why)
      reject(new Error(why))
    })
    lines.once('line', (line) => {
      clearTimeout(timer)
      let first
      try {
        first = JSON.parse(line)
      } catch {
        first = { ready: false, error: `its first line is not JSON: ${line.slice(0, 200)}` }
      }
      if (first.ready === true) resolve(helper)
      else {
        child.kill()
        reject(new Error(`the helper failed to start: ${String(first.error)}`))
      }
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Process trees

/** Everything one run shares: the temporary directory, the helpers, and what must be stopped afterwards. */
class Probe {
  tracked = []
  /** Console events that reached the driver; it has no console, so any is a finding (task 4.3). */
  driverEvents = 0
  #console

  constructor(dir, main) {
    this.dir = dir
    this.main = main
  }

  /** The helper that attaches to consoles, started again if an event ended it. */
  async console() {
    if (this.#console === undefined || !this.#console.alive) {
      this.#console = await startHelper()
      await this.#console.request('ignore-console-events')
    }
    return this.#console
  }

  /** Counts the signals Node turns console events into, instead of dying of them unrecorded. */
  watchDriver() {
    const count = () => {
      this.driverEvents++
    }
    process.on('SIGBREAK', count)
    process.on('SIGINT', count)
    return () => {
      process.off('SIGBREAK', count)
      process.off('SIGINT', count)
    }
  }

  async close() {
    await Promise.allSettled([this.main.close(), this.#console?.close()])
  }

  writeSpec(spec) {
    const file = specFile(this.dir, spec.name)
    writeAtomic(file, JSON.stringify({ ...spec, dir: this.dir }))
    return file
  }

  /** Spawns a worker directly, as Veydr spawns a command. */
  spawnWorker(spec, options = {}) {
    const child = spawn(process.execPath, [WORKER, this.writeSpec(spec)], { windowsHide: true, stdio: 'ignore', ...options })
    child.on('error', () => {})
    return child
  }

  async ready(name) {
    const file = readyFile(this.dir, name)
    const failure = errorFile(this.dir, name)
    const deadline = Date.now() + WORKER_READY_MS
    while (!existsSync(file)) {
      if (existsSync(failure)) throw new Error(`worker ${name} failed: ${readFileSync(failure, 'utf8')}`)
      if (Date.now() > deadline) throw new Error(`worker ${name} was not ready within ${WORKER_READY_MS / 1000} s`)
      await sleep(POLL_MS)
    }
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  async rows(pids) {
    return (await this.main.request('inspect', { pids })).Processes
  }

  /** Records running processes with their creation times, and tracks them for cleanup. */
  async track(named) {
    const rows = await this.rows(named.map((p) => p.pid))
    const members = named.map((p, i) => {
      if (rows[i]?.Running !== true) throw new Error(`${p.name} (PID ${p.pid}) is not running`)
      return { name: p.name, pid: p.pid, created: rows[i].Created }
    })
    this.tracked.push(...members)
    return members
  }

  /** Waits until none of `members` runs, for at most `ms`, and returns those still running. */
  async left(members, ms, options) {
    const deadline = Date.now() + ms
    for (;;) {
      const running = survivors(members, await this.rows(members.map((m) => m.pid)), options)
      if (running.length === 0 || Date.now() > deadline) return running
      await sleep(POLL_MS)
    }
  }

  /** Ends what a check left running. Runs after every check, so one check cannot affect the next. */
  async cleanup() {
    const members = this.tracked.splice(0)
    if (members.length === 0) return
    for (const member of survivors(members, await this.rows(members.map((m) => m.pid)), { tolerate: true })) {
      await this.main.request('terminate', { pid: member.pid }).catch(() => {})
    }
  }

  marker(name, signal) {
    return existsSync(markerFile(this.dir, name, signal))
  }

  /** Waits for a marker for at most `ms`. */
  async waitMarker(name, signal, ms) {
    const deadline = Date.now() + ms
    while (!this.marker(name, signal) && Date.now() < deadline) await sleep(POLL_MS)
    return this.marker(name, signal)
  }

  async taskkill(pid, tree = true) {
    const run = await runProgram(system32('taskkill.exe'), ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], { timeoutMs: REQUEST_MS })
    return { exitCode: run.code, output: `${run.stdout}${run.stderr}`.replace(/\s+/g, ' ').trim() }
  }

  async newJob() {
    return (await this.main.request('create-job')).job
  }

  /** A plain worker with a hidden console, tracked. */
  async plainChild(name, options = {}, spec = {}) {
    const child = this.spawnWorker({ ...spec, name }, options)
    await this.ready(name)
    const [member] = await this.track([{ name, pid: child.pid }])
    return { child, member }
  }

  /** Starts a tree: leader → child → grandchild, and with `orphan` a grandchild whose parent exited. */
  async tree(prefix, { orphan = false, beforeGo } = {}) {
    const name = (part) => `${prefix}-${part}`
    const go = beforeGo === undefined ? undefined : join(this.dir, `${prefix}.go`)
    const children = [{ name: name('child'), children: [{ name: name('grandchild') }] }]
    if (orphan) children.push({ name: name('bridge'), exitAfterReady: true, children: [{ name: name('orphan'), detached: true }] })
    const child = this.spawnWorker({ name: name('leader'), waitFor: go, children })
    if (beforeGo !== undefined) {
      await beforeGo(child.pid)
      writeAtomic(go, '')
    }
    const leaderReady = await this.ready(name('leader'))
    const childReady = await this.ready(name('child'))
    const named = [
      { name: name('leader'), pid: child.pid },
      { name: name('child'), pid: leaderReady.children[name('child')] },
      { name: name('grandchild'), pid: childReady.children[name('grandchild')] },
    ]
    if (orphan) {
      const bridgeReady = await this.ready(name('bridge'))
      named.push({ name: name('orphan'), pid: bridgeReady.children[name('orphan')] })
      const bridgePid = leaderReady.children[name('bridge')]
      // Its parent must really be gone, or the walk from the leader would still reach the orphan.
      const deadline = Date.now() + STOP_MS
      while ((await this.rows([bridgePid]))[0]?.Running === true) {
        if (Date.now() > deadline) throw new Error('the orphan\'s parent did not exit')
        await sleep(POLL_MS)
      }
    }
    const members = await this.track(named)
    return { child, members, descendants: members.slice(1), leader: members[0] }
  }

  /** Starts a worker from the helper, so with flags Node cannot request. */
  startFromHelper(spec, flags = {}) {
    return this.main.request('start', {
      application: process.execPath,
      commandLine: workerCommand(this.writeSpec(spec)),
      suspended: false,
      newGroup: false,
      breakaway: false,
      ...flags,
    })
  }
}

const describe = (members, left) => members.map((m) => ({ ...m, ended: !left.includes(m) }))

// ---------------------------------------------------------------------------------------------
// The checks. Each returns { answer, detail, data }.

async function control(probe) {
  const stops = {
    terminateProcess: (child) => child.kill(),
    taskkill: (child) => probe.taskkill(child.pid),
    terminateJob: async (child) => {
      const job = await probe.newJob()
      await probe.main.request('assign', { job, pid: child.pid })
      await probe.main.request('terminate-job', { job })
    },
  }
  const methods = {}
  const failed = []
  for (const [method, stop] of Object.entries(stops)) {
    const { child, member } = await probe.plainChild(`control-${method}`)
    await stop(child)
    const left = await probe.left([member], STOP_MS)
    methods[method] = { pid: member.pid, created: member.created, ended: left.length === 0 }
    if (left.length > 0) failed.push(method)
  }
  return { answer: failed.length === 0 ? 'yes' : 'no', detail: failed.length === 0 ? '' : `the plain child survived: ${failed.join(', ')}`, data: { methods } }
}

async function libuvJob(probe) {
  const { child, member } = await probe.plainChild('libuv-job')
  const childInJob = (await probe.main.request('in-job', { pid: child.pid, job: 0 })).inJob
  const ownJob = await probe.main.request('own-job')
  const result = libuvJobAnswer({ childInJob, driverPid: process.pid, childPid: child.pid, ownJob })
  return { ...result, data: { process: member, childInJob, driverPid: process.pid, jobProcesses: ownJob.Pids, ...limitsData(ownJob) } }
}

const limitsData = (ownJob) =>
  ownJob.LimitFlags === null || ownJob.LimitFlags === undefined
    ? { limitsUnreadable: String(ownJob.LimitsError ?? 'the helper is in no job') }
    : { limitFlags: `0x${ownJob.LimitFlags.toString(16)}`, limits: jobLimitNames(ownJob.LimitFlags) }

const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000
const limitsAllowSilentBreakaway = (ownJob) => ((ownJob.LimitFlags ?? 0) & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) !== 0

async function libuvBreakaway(probe) {
  // The helper is the child in libuv's job, so what it starts is that job's grandchild.
  const before = await probe.main.request('own-job')
  if (before.Pids === null || before.Pids === undefined) {
    return { answer: null, detail: `the job's processes could not be listed: ${String(before.PidsError ?? 'the helper is in no job')}`, data: limitsData(before) }
  }
  let started
  try {
    started = await probe.startFromHelper({ name: 'breakaway' }, { breakaway: true })
  } catch (error) {
    if (error.code !== ERROR_ACCESS_DENIED) throw error
    return { answer: 'no', detail: `CREATE_BREAKAWAY_FROM_JOB was refused, possibly by a job above libuv's: ${error.message}`, data: { jobProcesses: before.Pids, ...limitsData(before) } }
  }
  await probe.ready('breakaway')
  const [member] = await probe.track([{ name: 'breakaway', pid: started.pid }])
  const plain = await probe.startFromHelper({ name: 'no-breakaway' })
  await probe.ready('no-breakaway')
  const [plainMember] = await probe.track([{ name: 'no-breakaway', pid: plain.pid }])
  const after = await probe.main.request('own-job')
  const stayed = (after.Pids ?? []).includes(started.pid)
  const plainStayed = (after.Pids ?? []).includes(plain.pid)
  const data = { process: member, plainGrandchild: plainMember, plainGrandchildInLibuvJob: plainStayed, jobProcesses: after.Pids, ...limitsData(after) }
  // The plain grandchild is the control: libuv's job lets it leave silently, so its absence is expected only with that limit set.
  if (!stayed && !plainStayed && !limitsAllowSilentBreakaway(after)) return { answer: null, detail: 'neither grandchild is listed in the job, though the job does not allow silent breakaway, so the list says nothing', data }
  return stayed ? { answer: 'no', detail: 'the grandchild is still in libuv\'s job', data } : { answer: 'yes', detail: '', data }
}

async function killLeader(probe) {
  const tree = await probe.tree('kill-leader', { orphan: true })
  tree.child.kill()
  await probe.left([tree.leader], STOP_MS)
  const left = await probe.left(tree.descendants, STOP_MS)
  // The detached orphan survives by construction, so `nonOrphansEnded` carries what libuv's job did.
  const nonOrphansEnded = left.every((m) => m.name.endsWith('-orphan'))
  return { ...allEndedAnswer(tree.descendants, left, 'child.kill()'), data: { nonOrphansEnded, processes: describe(tree.members, left) } }
}

async function taskkillTree(probe) {
  const tree = await probe.tree('taskkill-tree')
  const taskkill = await probe.taskkill(tree.child.pid)
  const left = await probe.left(tree.members, STOP_MS)
  return { ...allEndedAnswer(tree.members, left, 'taskkill /T /F'), data: { taskkill, processes: describe(tree.members, left) } }
}

async function taskkillOrphan(probe) {
  const tree = await probe.tree('taskkill-orphan', { orphan: true })
  const taskkill = await probe.taskkill(tree.child.pid)
  const left = await probe.left(tree.members, STOP_MS)
  const orphan = tree.members.filter((m) => m.name.endsWith('-orphan'))
  return { ...allEndedAnswer(orphan, left, 'taskkill /T /F on the leader'), data: { taskkill, processes: describe(tree.members, left) } }
}

async function jobTerminate(probe) {
  const job = await probe.newJob()
  const tree = await probe.tree('job-terminate', {
    orphan: true,
    beforeGo: (pid) => probe.main.request('assign', { job, pid }),
  })
  const contained = {}
  for (const member of tree.members) contained[member.name] = (await probe.main.request('in-job', { pid: member.pid, job })).inJob
  await probe.main.request('terminate-job', { job })
  const left = await probe.left(tree.members, STOP_MS)
  const escaped = Object.entries(contained).filter(([, inJob]) => !inJob).map(([name]) => name)
  const data = { contained, processes: describe(tree.members, left) }
  if (escaped.length > 0) return { answer: 'no', detail: `not in the job: ${escaped.join(', ')}`, data }
  return { ...allEndedAnswer(tree.members, left, 'TerminateJobObject'), data }
}

/** Both parent-exit checks read one scenario, run once. */
async function parentExit(probe) {
  // Detached, like a Veydr that nothing holds: not in the driver's job, and without a console.
  const parent = probe.spawnWorker(
    {
      name: 'crash-parent',
      children: [
        { name: 'crash-leader', children: [{ name: 'crash-grandchild' }] },
        { name: 'crash-cmd-grandchild', via: 'cmd' },
      ],
    },
    { detached: true },
  )
  const parentReady = await probe.ready('crash-parent')
  const leaderReady = await probe.ready('crash-leader')
  const leaders = await probe.track([
    { name: 'crash-leader', pid: parentReady.children['crash-leader'] },
    { name: 'crash-cmd-leader', pid: parentReady.children['crash-cmd-grandchild'] },
  ])
  const cmdReady = await probe.ready('crash-cmd-grandchild')
  const grandchildren = await probe.track([
    { name: 'crash-grandchild', pid: leaderReady.children['crash-grandchild'] },
    { name: 'crash-cmd-grandchild', pid: cmdReady.pid },
  ])
  const [parentMember] = await probe.track([{ name: 'crash-parent', pid: parent.pid }])
  await probe.main.request('terminate', { pid: parent.pid })
  const parentLeft = await probe.left([parentMember], STOP_MS)
  if (parentLeft.length > 0) throw new Error('the parent survived TerminateProcess')
  await sleep(SETTLE_MS)
  const all = [...leaders, ...grandchildren]
  const running = survivors(all, await probe.rows(all.map((m) => m.pid)))
  const processes = describe(all, running).map((m) => ({ ...m, variant: m.name.includes('-cmd-') ? 'cmd' : 'node' }))
  return { parent: parentMember, leaders, grandchildren, running, processes }
}

/** yes if any of `members` keeps running: W1 must then look for survivors. */
function keptRunning(members, running, what) {
  const kept = members.filter((m) => running.includes(m))
  return kept.length > 0 ? { answer: 'yes', detail: '' } : { answer: 'no', detail: `no ${what} kept running` }
}

async function jobRace(probe) {
  // The grandchild exists before the assignment: `ready` is written after it started.
  const spawned = probe.spawnWorker({ name: 'race-leader', children: [{ name: 'race-grandchild' }] })
  const spawnedReady = await probe.ready('race-leader')
  const [raced] = await probe.track([{ name: 'race-grandchild', pid: spawnedReady.children['race-grandchild'] }])
  await probe.track([{ name: 'race-leader', pid: spawned.pid }])
  const racedJob = await probe.newJob()
  await probe.main.request('assign', { job: racedJob, pid: spawned.pid })
  const contained = (await probe.main.request('in-job', { pid: raced.pid, job: racedJob })).inJob

  // The same tree, started suspended from the helper and assigned before its first instruction.
  const suspendedJob = await probe.newJob()
  const { pid } = await probe.startFromHelper({ name: 'suspended-leader', children: [{ name: 'suspended-grandchild' }] }, { suspended: true })
  await probe.main.request('assign', { job: suspendedJob, pid })
  await probe.main.request('resume', { pid })
  const suspendedReady = await probe.ready('suspended-leader')
  const [suspended] = await probe.track([{ name: 'suspended-grandchild', pid: suspendedReady.children['suspended-grandchild'] }])
  await probe.track([{ name: 'suspended-leader', pid }])
  const suspendedContained = (await probe.main.request('in-job', { pid: suspended.pid, job: suspendedJob })).inJob

  const data = {
    assignedAfterSpawn: { grandchild: raced, contained },
    assignedWhileSuspended: { grandchild: suspended, contained: suspendedContained, closesTheGap: suspendedContained },
  }
  return contained ? { answer: 'yes', detail: '', data } : { answer: 'no', detail: 'the grandchild created before the assignment is outside the job', data }
}

async function ctrlBreakDirect(probe) {
  const { member } = await probe.plainChild('direct', { detached: true }, { signals: true })
  const send = await probe.main.request('send-ctrl-direct', { pid: member.pid })
  const marker = await probe.waitMarker('direct', 'break', SETTLE_MS)
  const data = { process: member, send }
  return marker ? { answer: 'yes', detail: '', data } : { answer: 'no', detail: `the event did not reach the child (sent: ${String(send.Sent)}, error ${send.SendError})`, data }
}

/** How to start each graceful-stop child, which ends in a worker that handles SIGBREAK. */
function attachCommand(probe, child, name) {
  const spec = probe.writeSpec({ name, signals: true })
  if (child === 'node') return { file: process.execPath, args: [WORKER, spec], options: {} }
  const verbatim = (line) => ({ file: system32('cmd.exe'), args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } })
  if (child === 'cmd') return verbatim(workerCommand(spec))
  const project = join(probe.dir, name)
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'veydr-probe', private: true, scripts: { probe: workerCommand(spec) } }))
  const bin = dirname(process.execPath)
  // The standard user's profile does not have the job's PATH additions (design D9).
  const pathName = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const env = { ...process.env, [pathName]: `${bin};${process.env[pathName] ?? ''}` }
  return { ...verbatim(`"${join(bin, 'npm.cmd')}" run probe`), options: { windowsVerbatimArguments: true, cwd: project, env } }
}

/**
 * The events each side received. The helper is on the child's console when it sends event 0, so it
 * receives it too and swallows it (design D3): a count above zero there is expected, and shows that
 * only its handler kept it alive. The driver must count none.
 */
async function eventCounts(helper, helperAlive, driverEvents) {
  const helperEventsSwallowed = helperAlive ? (await helper.request('events-swallowed')).count : null
  return { driverEvents, helperEventsSwallowed }
}

async function ctrlBreakAttach(probe, child) {
  const name = `attach-${child}`
  const { file, args, options } = attachCommand(probe, child, name)
  // windowsHide and not detached, with stdin ignored and the output piped, as the supervisor starts a command.
  const leader = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let output = ''
  const keep = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-300)
  }
  leader.stdout.on('data', keep)
  leader.stderr.on('data', keep)
  leader.on('error', () => {})
  try {
    await probe.ready(name)
    const { Processes: processes } = await probe.main.request('snapshot')
    const pids = descendantsOf(processes, leader.pid)
    // A snapshot can hold a process that has just ended; only what runs now is part of the tree.
    const rows = await probe.rows(pids)
    // The console host is often a child of the console's first process, but no part of the tree.
    const isHost = (pid) => /^(conhost|openconsole)\.exe$/i.test(processes.find((p) => p.Pid === pid)?.Name ?? '')
    const running = pids.filter((pid, i) => rows[i]?.Running === true && !isHost(pid))
    const unreadable = pids.filter((_, i) => rows[i]?.Error !== null && rows[i]?.Error !== undefined)
    const members = await probe.track(running.map((pid) => ({ pid, name: `${processes.find((p) => p.Pid === pid)?.Name ?? 'unknown'}#${pid}` })))
    const helper = await probe.console()
    const eventsBefore = probe.driverEvents
    const send = await helper.request('send-ctrl', { pid: leader.pid, event: CTRL_BREAK_EVENT })
    const marker = await probe.waitMarker(name, 'break', GRACEFUL_MS)
    const left = await probe.left(members, GRACEFUL_MS, { tolerate: true })
    const finalRows = await probe.rows(members.map((m) => m.pid))
    const unknown = members.filter((_, i) => finalRows[i]?.Error !== null && finalRows[i]?.Error !== undefined)
    const helperAlive = await helper.alivePing()
    const driverEvents = probe.driverEvents - eventsBefore
    const data = { send, marker, helperAlive, ...(await eventCounts(helper, helperAlive, driverEvents)), driverPid: process.pid, unreadable, unknown: unknown.map((m) => m.name), processes: describe(members, left), output }
    return { ...gracefulAnswer({ send, marker, left, helperAlive, driverEvents, unknown }), data }
  } finally {
    await probe.taskkill(leader.pid)
  }
}

async function ctrlBreakDetached(probe) {
  const name = 'attach-detached'
  probe.spawnWorker({ name, signals: true }, { detached: true })
  const { pid } = await probe.ready(name)
  const [member] = await probe.track([{ name, pid }])
  const helper = await probe.console()
  const eventsBefore = probe.driverEvents
  const send = await helper.request('send-ctrl', { pid, event: CTRL_BREAK_EVENT })
  const marker = await probe.waitMarker(name, 'break', SETTLE_MS)
  const left = await probe.left([member], send.Attached ? GRACEFUL_MS : 0)
  const helperAlive = await helper.alivePing()
  const driverEvents = probe.driverEvents - eventsBefore
  const data = { process: member, send, marker, helperAlive, ...(await eventCounts(helper, helperAlive, driverEvents)) }
  return { ...gracefulAnswer({ send, marker, left, helperAlive, driverEvents }), data }
}

async function ctrlC(probe) {
  const helper = await probe.console()
  // The control: the same event, to a child in the driver's own kind of process group.
  const { member: baseline } = await probe.plainChild('ctrl-c-baseline', {}, { signals: true })
  const baselineSend = await helper.request('send-ctrl', { pid: baseline.pid, event: CTRL_C_EVENT })
  const baselineMarker = await probe.waitMarker('ctrl-c-baseline', 'int', SETTLE_MS)
  const started = await probe.startFromHelper({ name: 'ctrl-c-group', signals: true }, { newGroup: true })
  await probe.ready('ctrl-c-group')
  const [member] = await probe.track([{ name: 'ctrl-c-group', pid: started.pid }])
  const send = await helper.request('send-ctrl', { pid: started.pid, event: CTRL_C_EVENT })
  const groupMarker = await probe.waitMarker('ctrl-c-group', 'int', SETTLE_MS)
  const data = { baseline: { ...baseline, send: baselineSend, marker: baselineMarker }, newGroup: { ...member, send, marker: groupMarker } }
  return { ...ctrlCAnswer({ baselineMarker, groupMarker, send }), data }
}

async function consoleWindow(probe) {
  const helper = await probe.console()
  const station = await helper.request('window-station')
  const hiddenChild = await probe.plainChild('window-hidden', { windowsHide: true })
  const hidden = await helper.request('console-window', { pid: hiddenChild.child.pid })
  const shownChild = await probe.plainChild('window-shown', { windowsHide: false })
  const shown = await helper.request('console-window', { pid: shownChild.child.pid })
  return { ...consoleWindowAnswer({ station, hidden, shown }), data: { station, windowsHide: hidden, withoutWindowsHide: shown, processes: [hiddenChild.member, shownChild.member] } }
}

async function identity(probe) {
  const { member } = await probe.plainChild('identity')
  const reads = [member.created]
  for (let i = 0; i < 3; i++) {
    await sleep(500)
    reads.push((await probe.rows([member.pid]))[0]?.Created)
  }
  const stable = reads.every((read) => read === member.created)
  return { answer: stable ? 'yes' : 'no', detail: stable ? '' : 'the creation time changed between reads', data: { pid: member.pid, created: reads } }
}

async function identityReuse(probe) {
  const reuse = await probe.main.request(
    'pid-reuse',
    { application: system32('cmd.exe'), commandLine: 'cmd.exe /d /c exit', maxProcesses: REUSE_MAX_PROCESSES, maxMs: REUSE_MAX_MS },
    REUSE_MAX_MS + REQUEST_MS,
  )
  return { ...reuseAnswer(reuse), data: { reuse } }
}

// ---------------------------------------------------------------------------------------------

/** Runs the checks `ids` holds, in order, each isolated: one that throws answers null with the reason. */
async function runChecks(probe, ids, report) {
  const run = async (id, check) => {
    if (!ids.includes(id)) return
    let result
    try {
      result = await check()
    } catch (error) {
      result = { answer: null, detail: `the probe failed: ${message(error)}`, data: {} }
    }
    report(id, result.answer, result.detail, result.data)
    await probe.cleanup().catch(() => {})
  }
  const suffix = ids.includes('pt-control') ? '' : '-std'
  await run(`pt-control${suffix}`, () => control(probe))
  await run(`pt-job-terminate${suffix}`, () => jobTerminate(probe))
  for (const child of ['node', 'npm', 'cmd']) await run(`pt-ctrl-break-attach-${child}${suffix}`, () => ctrlBreakAttach(probe, child))
  await run('pt-libuv-job', () => libuvJob(probe))
  await run('pt-libuv-breakaway', () => libuvBreakaway(probe))
  await run('pt-kill-leader', () => killLeader(probe))
  await run('pt-taskkill-tree', () => taskkillTree(probe))
  await run('pt-taskkill-orphan', () => taskkillOrphan(probe))
  await run('pt-job-race', () => jobRace(probe))
  await run('pt-ctrl-break-direct', () => ctrlBreakDirect(probe))
  await run('pt-ctrl-break-detached', () => ctrlBreakDetached(probe))
  await run('pt-ctrl-c', () => ctrlC(probe))
  await run('pt-console-window', () => consoleWindow(probe))
  await run('pt-identity', () => identity(probe))
  await run('pt-identity-reuse', () => identityReuse(probe))
  if (ids.includes('pt-parent-exit-leader')) {
    let scenario
    try {
      scenario = await parentExit(probe)
    } catch (error) {
      for (const id of ['pt-parent-exit-leader', 'pt-parent-exit-descendant']) report(id, null, `the probe failed: ${message(error)}`, {})
    }
    if (scenario !== undefined) {
      const data = { parent: scenario.parent, processes: scenario.processes }
      const leader = keptRunning(scenario.leaders, scenario.running, 'leader')
      const descendant = keptRunning(scenario.grandchildren, scenario.running, 'grandchild')
      report('pt-parent-exit-leader', leader.answer, leader.detail, data)
      report('pt-parent-exit-descendant', descendant.answer, descendant.detail, data)
    }
    await probe.cleanup().catch(() => {})
  }
}

async function probeProcessTree(ids, report) {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-probe-tree-'))
  let main
  try {
    main = await startHelper()
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    for (const id of ids) report(id, null, `process-tree.ps1 is not available: ${message(error)}`, {})
    return
  }
  const probe = new Probe(dir, main)
  const unwatch = probe.watchDriver()
  try {
    await runChecks(probe, ids, report)
  } finally {
    unwatch()
    await probe.close()
    // A file a worker still holds must not fail a run whose results are written.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Runs the driver for a parsed command line; `options` are passed on to runDriver (tests). */
export async function runProcessTree(args, options = {}) {
  const { user, unavailable, positional } = parseDriverArgs(args)
  if (positional.length > 0) throw new DriverUsageError(`expected no positional arguments, got ${JSON.stringify(positional)}`)
  const ids = placeholderIds(AREA, user)
  await runDriver({ ...options, area: AREA, user, ids, unavailable, probe: (report) => probeProcessTree(ids, report) })
}

if (isEntryPoint(import.meta.url)) driverMain('process-tree.mjs', runProcessTree)
