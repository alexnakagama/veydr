import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyConfig } from '../../src/shared/config'

// Runs the built app (`npm run test:integration` builds it first) the way a user would,
// with a temporary HOME so the real ~/.config is never touched.
const repoRoot = resolve(__dirname, '../..')
const electronBinary = createRequire(__filename)('electron') as string

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-location-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function launch(env: { HOME: string; XDG_CONFIG_HOME?: string }): ChildProcess {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS' || key === 'XDG_CONFIG_HOME') continue
    base[key] = value
  }
  // X11 finds its cookie through HOME unless XAUTHORITY is set; keep the real one.
  const xauthority = join(homedir(), '.Xauthority')
  if (base['XAUTHORITY'] === undefined && existsSync(xauthority)) base['XAUTHORITY'] = xauthority

  const child = spawn(electronBinary, [repoRoot], { env: { ...base, ...env }, stdio: 'ignore' })
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done()
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
        child.once('exit', () => {
          clearTimeout(timer)
          done()
        })
        child.kill('SIGTERM')
      }),
  )
  return child
}

async function waitFor(condition: () => boolean, what: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!condition()) {
    if (child.exitCode !== null) throw new Error(`app exited (${child.exitCode}) before ${what}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Paths under `root` named like Veydr's directory or configuration files, relative to `root`. */
function veydrPaths(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.name === 'Veydr' || entry.name.startsWith('config.json')) found.push(relative(root, full))
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return found.sort()
}

const mode = (path: string): number => statSync(path).mode & 0o777
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

describe('configuration location on Linux', () => {
  it('[spec:config-storage/default-linux-location] uses ~/.config/Veydr when XDG_CONFIG_HOME is unset', async () => {
    const home = tempDir()
    const child = launch({ HOME: home })
    const configFile = join(home, '.config', 'Veydr', 'config.json')
    await waitFor(() => existsSync(configFile), configFile, child)

    expect(readJson(configFile)).toEqual(emptyConfig())
    expect(mode(join(home, '.config', 'Veydr'))).toBe(0o700)
    expect(mode(configFile)).toBe(0o600)
    // Nothing Veydr-owned anywhere else in HOME (Chromium's own dot-directories vary by machine).
    expect(veydrPaths(home)).toEqual([join('.config', 'Veydr'), join('.config', 'Veydr', 'config.json')])
  })

  it('[spec:config-storage/xdg-override-honored] uses $XDG_CONFIG_HOME/Veydr when it is set', async () => {
    const home = tempDir()
    const xdg = tempDir()
    const child = launch({ HOME: home, XDG_CONFIG_HOME: xdg })
    const configFile = join(xdg, 'Veydr', 'config.json')
    await waitFor(() => existsSync(configFile), configFile, child)

    expect(readJson(configFile)).toEqual(emptyConfig())
    expect(mode(join(xdg, 'Veydr'))).toBe(0o700)
    expect(mode(configFile)).toBe(0o600)
    expect(existsSync(join(home, '.config', 'Veydr'))).toBe(false)
  })

  it('[spec:config-storage/linux-permissions] tightens an existing directory to 0700 and config files to 0600', async () => {
    const home = tempDir()
    const xdg = tempDir()
    const dir = join(xdg, 'Veydr')
    mkdirSync(dir, { mode: 0o755 })
    const content = `${JSON.stringify(emptyConfig(), null, 2)}\n`
    writeFileSync(join(dir, 'config.json'), content, { mode: 0o644 })
    writeFileSync(join(dir, 'config.json.bak'), content, { mode: 0o644 })
    expect([mode(dir), mode(join(dir, 'config.json'))]).toEqual([0o755, 0o644])

    const child = launch({ HOME: home, XDG_CONFIG_HOME: xdg })
    await waitFor(
      () => mode(dir) === 0o700 && mode(join(dir, 'config.json')) === 0o600 && mode(join(dir, 'config.json.bak')) === 0o600,
      'modes 0700/0600',
      child,
    )
    // Loading a valid configuration does not rewrite it.
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(content)
  })
})
