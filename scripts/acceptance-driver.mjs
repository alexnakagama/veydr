// Acceptance pass of the installed package (task 10.2). Runs inside the container started by
// scripts/acceptance-linux.sh, as an unprivileged user, on an X display with a window manager.
// Drives the real `veydr` (from the .deb) through its window over the Chromium debugging port and
// the native folder picker through xdotool. Every step is appended to $RESULTS/steps.jsonl.
//
//   node acceptance-driver.mjs   (env: RESULTS, NODE_BIN, REPO, DISPLAY)
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const results = process.env.RESULTS
const nodeBin = process.env.NODE_BIN
const repo = process.env.REPO
if (!results || !nodeBin || !repo) throw new Error('RESULTS, NODE_BIN and REPO are required')

const TAG = 'VEYDR_ACCEPTANCE_TAG'
const tag = crypto.randomUUID()
const configDir = join(homedir(), '.config/Veydr')
const projects = { shop: join(homedir(), 'projects/shop'), blog: join(homedir(), 'projects/blog') }
const ledger = join(homedir(), 'listen-ledger.jsonl')
const workerSignal = join(homedir(), 'worker-signal')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function record(step, ok, detail) {
  appendFileSync(join(results, 'steps.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), step, ok, detail })}\n`)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${JSON.stringify(detail)}`)
  if (!ok) throw new Error(`step failed: ${step}`)
}

async function until(what, check, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

/** Processes carrying this run's tag (the commands and their descendants). */
function tagged() {
  const found = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(`${TAG}=${tag}`)) {
        found.push({ pid: Number(name), exe: readlinkSync(`/proc/${name}/exe`) })
      }
    } catch {
      // Exited, or not ours.
    }
  }
  return found
}

const xdotool = (...args) => execFileSync('xdotool', args, { encoding: 'utf8' }).trim()

/** Starts the installed Veydr and connects to its window. */
async function launch() {
  rmSync(join(configDir, 'DevToolsActivePort'), { force: true })
  const child = spawn('veydr', ['--remote-debugging-port=0'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += String(chunk)))
  const exit = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  const port = await until('the debugging port', () => existsSync(join(configDir, 'DevToolsActivePort')) && Number(readFileSync(join(configDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]), 60_000)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = await until('the Veydr page', () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url() === 'app://veydr/index.html'))
  await page.getByRole('heading', { level: 1, name: 'Projects' }).waitFor()
  return { child, page, browser, exit, stderr: () => stderr }
}

const command = (page, id) => page.locator(`[data-command-id="${id}"]`)
const status = (page, id) => command(page, id).getByTestId('command-status').textContent()

async function registerProject(page, path, name) {
  const before = xdotool('getactivewindow')
  const click = page.getByRole('button', { name: 'Add project', exact: true }).click()
  // The GTK folder chooser opens as a new window and takes focus.
  const picker = await until('the folder picker', () => {
    const active = xdotool('getactivewindow')
    return active !== before ? active : null
  })
  const title = xdotool('getwindowname', picker)
  // Real (XTEST) input: GTK ignores events sent to a window (`--window`). The location bar takes
  // the path; the Open button (Alt+O) chooses it. (Return there closed the chooser as cancelled.)
  xdotool('key', 'ctrl+l')
  await sleep(500)
  xdotool('type', '--delay', '20', `${path}/`)
  await sleep(500)
  xdotool('key', 'alt+o')
  await click
  const dialog = page.getByTestId('project-dialog')
  await until('the add-project dialog', async () => (await dialog.getByTestId('project-dialog-path').textContent().catch(() => null)) === path, 30_000)
  await dialog.getByLabel('Project name', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  record(`register project ${name}`, true, { path, picker: title })
}

async function addCommand(page, project, name, setup) {
  await page.getByRole('button', { name: `Add command to ${project}`, exact: true }).click()
  const editor = page.getByTestId('command-editor')
  await editor.getByLabel('Name', { exact: true }).fill(name)
  await setup(editor)
  await editor.getByRole('button', { name: 'Add variable', exact: true }).click()
  await editor.getByLabel('Variable 1 name', { exact: true }).fill(TAG)
  await editor.getByLabel('Variable 1 value', { exact: true }).fill(tag)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
  const saved = config.projects.find((p) => p.name === project).commands.find((c) => c.name === name)
  record(`add command ${project} › ${name}`, true, { id: saved.id, execution: saved.execution })
  return saved.id
}

const direct = (file, args) => async (editor) => {
  await editor.getByLabel('Executable', { exact: true }).fill(file)
  for (const [index, value] of args.entries()) {
    await editor.getByRole('button', { name: 'Add argument', exact: true }).click()
    await editor.getByLabel(`Argument ${index + 1}`, { exact: true }).fill(value)
  }
}

const shell = (script) => async (editor) => {
  await editor.getByRole('radio', { name: 'Shell script', exact: true }).check()
  await editor.getByLabel('Script', { exact: true }).fill(script)
}

async function start(page, id, name) {
  await command(page, id).getByRole('button', { name: `Start ${name}`, exact: true }).click()
  await until(`${name} running`, async () => (await status(page, id)) === 'Running')
}

/** Round trip of one IPC request from the window, in ms. */
const ping = (page) => page.evaluate(async () => {
  const started = performance.now()
  await window.veydr.app.getInfo()
  return performance.now() - started
})

const rssMiB = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024

async function main() {
  mkdirSync(results, { recursive: true })
  for (const dir of Object.values(projects)) mkdirSync(dir, { recursive: true })
  const os = /PRETTY_NAME="(.*)"/.exec(readFileSync('/etc/os-release', 'utf8'))?.[1]
  record('environment', true, {
    os,
    deb: readFileSync(join(results, 'deb.sha256'), 'utf8').trim(),
    veydr: readlinkSync('/usr/bin/veydr'),
    sandbox: execFileSync('stat', ['-c', '%a', '/opt/Veydr/chrome-sandbox'], { encoding: 'utf8' }).trim(),
  })

  // --- First session: register, configure, start all, flood, ports, quit with running commands.
  let app = await launch()
  let { page } = app
  record('launch', true, { pid: app.child.pid, packaged: (await page.evaluate(() => window.veydr.app.getInfo())).value })

  await registerProject(page, projects.shop, 'shop')
  await registerProject(page, projects.blog, 'blog')
  const web = await addCommand(page, 'shop', 'web', direct(nodeBin, [join(repo, 'test/fixtures/proc/listen.mjs'), '--ledger', ledger, '--role', 'web']))
  const floodBytes = 100 * 10_000_000
  const flood = await addCommand(page, 'shop', 'flood', direct(nodeBin, [join(repo, 'test/fixtures/proc/flood.mjs'), '--bytes', String(floodBytes), '--report', join(homedir(), 'flood-report.json')]))
  // The trap records how the worker ends when its output loses its reader (see the crash step).
  const worker = await addCommand(page, 'blog', 'worker', shell(`trap 'echo SIGPIPE > ${workerSignal}; exit 141' PIPE; i=0; while true; do i=$((i+1)); echo "job $i done"; sleep 0.2; done`))

  const idlePing = await ping(page)
  for (const [id, name] of [[web, 'web'], [flood, 'flood'], [worker, 'worker']]) await start(page, id, name)
  record('start all', true, { running: [await status(page, web), await status(page, flood), await status(page, worker)], tagged: tagged().length })

  // Flood: 10 million 100-byte lines (1 GB) while the window keeps answering: one IPC ping every ~20 ms in
  // its own loop, the command's status and the main process's memory checked separately.
  await command(page, flood).locator('.command-name').click()
  const pings = []
  let peakRss = 0
  let flooding = true
  const pinger = (async () => {
    while (flooding) {
      pings.push(await ping(page))
      await sleep(20)
    }
  })()
  while ((await status(page, flood)) === 'Running') {
    peakRss = Math.max(peakRss, rssMiB(app.child.pid))
    await sleep(250)
  }
  flooding = false
  await pinger
  const report = JSON.parse(readFileSync(join(homedir(), 'flood-report.json'), 'utf8'))
  const sorted = [...pings].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const view = page.getByTestId('log-view')
  // Following: the newest line is shown last; seq counts lines from 1.
  const lastSeq = await until('the last line shown', async () => {
    const seqs = (await view.getByTestId('log-line').evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-seq')))))
    return seqs.includes(floodBytes / 100) ? Math.max(...seqs) : null
  }).catch(() => null)
  const lines = await view.getByTestId('log-line').count()
  const discarded = (await view.getByTestId('log-discarded').textContent().catch(() => null)) ?? null
  const floodStatus = await status(page, flood)
  // Unthrottled, this producer runs at about 30 times the rate of design D14's P1 (5 MB/s), whose
  // 50 ms ping p95 test:perf verifies; here the window must stay responsive: no ping above 200 ms
  // (D14's long-task limit), over at least 50 pings. p95 is recorded, not judged.
  const maxPing = sorted.at(-1) ?? Infinity
  record('flood logs', floodStatus === 'Exited' && pings.length >= 50 && maxPing <= 200 && lastSeq === floodBytes / 100 && discarded !== null, {
    produced: report,
    status: floodStatus,
    pingsDuringFlood: pings.length,
    pingP95Ms: Number(p95.toFixed(1)),
    pingMaxMs: Number((sorted.at(-1) ?? 0).toFixed(1)),
    idlePingMs: Number(idlePing.toFixed(1)),
    mainPeakRssMiB: Number(peakRss.toFixed(1)),
    renderedRows: lines,
    lastShownSeq: lastSeq,
    expectedLastSeq: floodBytes / 100,
    discardedNote: discarded,
  })
  await command(page, worker).locator('.command-name').click()
  await view.getByTestId('log-text').filter({ hasText: /^job \d+ done$/ }).first().waitFor()
  record('worker output shown', true, { firstLine: await view.getByTestId('log-text').first().textContent() })

  // Ports.
  const port = await until('web listening', () => existsSync(ledger) && readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.role === 'web')?.port)
  await page.getByRole('button', { name: 'Ports', exact: true }).click()
  const row = page.getByTestId('ports-managed-table').locator(`[data-testid="port-row"][data-port="${port}"]`)
  await row.waitFor()
  record('view ports', (await row.getByTestId('port-command').textContent()) === 'shop › web', {
    port,
    command: await row.getByTestId('port-command').textContent(),
    process: await row.getByTestId('port-process').textContent(),
    allListeners: await page.getByTestId('ports-all-table').getByTestId('port-row').count(),
  })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()

  // Quit with running commands: close the window the way a window manager does.
  const runningBefore = tagged()
  // Watch for the progress overlay before asking to close, so a fast quit cannot outrun the check.
  const overlaySeen = page.getByTestId('quit-overlay').textContent({ timeout: 10_000 }).catch(() => null)
  const closeAt = Date.now()
  execFileSync('wmctrl', ['-c', 'Veydr'])
  const overlay = await overlaySeen
  const exited = await Promise.race([app.exit, sleep(30_000).then(() => null)])
  const quitMs = Date.now() - closeAt
  const ledgerFile = join(configDir, 'runtime/ledger.json')
  record('quit with running commands', exited?.code === 0 && tagged().length === 0 && overlay !== null, {
    runningBefore: runningBefore.length,
    overlay,
    quitMs,
    exit: exited,
    left: tagged(),
    runtimeFiles: existsSync(join(configDir, 'runtime')) ? readdirSync(join(configDir, 'runtime')) : [],
    ledger: existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : null,
  })

  // --- Second session: crash with running commands.
  app = await launch()
  page = app.page
  record('relaunch', true, { commandsIdle: [await status(page, web), await status(page, worker)] })
  await start(page, web, 'web')
  await start(page, worker, 'worker')
  const beforeCrash = tagged()
  process.kill(app.child.pid, 'SIGKILL')
  const crashed = await app.exit
  await sleep(1000)
  const survivors = tagged()
  // The listener writes nothing and keeps running; the worker's next `echo` has no reader any more
  // and ends it (SIGPIPE, recorded by its trap), as documented in docs/processes.md.
  const listener = beforeCrash.find((p) => p.exe === nodeBin)
  const workerEnding = await until('the worker to record its ending', () => existsSync(workerSignal) && readFileSync(workerSignal, 'utf8').trim(), 5000).catch(() => null)
  record('crash (SIGKILL of the main process)', crashed.signal === 'SIGKILL' && survivors.some((p) => p.pid === listener?.pid) && survivors.every((p) => beforeCrash.some((b) => b.pid === p.pid)) && workerEnding === 'SIGPIPE', {
    before: beforeCrash,
    exit: crashed,
    workerEnding,
    survivors,
    ended: beforeCrash.filter((b) => !survivors.some((p) => p.pid === b.pid)),
  })

  // --- Third session: recovery.
  app = await launch()
  page = app.page
  const notice = page.locator('[data-testid="notice"][data-kind="crash-survivors"]')
  await notice.waitFor()
  const message = await notice.locator('.notice-message').textContent()
  const listed = await notice.getByTestId('notice-process').allTextContents()
  const idle = [await status(page, web), await status(page, worker)]
  const stillThere = tagged()
  await notice.getByRole('button', { name: 'Terminate', exact: true }).click()
  await notice.waitFor({ state: 'detached' })
  await until('survivors terminated', () => tagged().length === 0)
  record('recover', idle.every((s) => s === 'Idle') && listed.length === stillThere.length && stillThere.every((p) => listed.some((l) => l.includes(String(p.pid)))), {
    message,
    listed,
    survivorsAtLaunch: stillThere,
    commandsAfterLaunch: idle,
    left: tagged(),
  })

  execFileSync('wmctrl', ['-c', 'Veydr'])
  const last = await Promise.race([app.exit, sleep(30_000).then(() => null)])
  record('final quit', last?.code === 0, { exit: last })
}

main().then(
  () => process.exit(0),
  (error) => {
    appendFileSync(join(results, 'steps.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), step: 'driver', ok: false, detail: String(error?.stack ?? error) })}\n`)
    console.error(error)
    process.exit(1)
  },
)
