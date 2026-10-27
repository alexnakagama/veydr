// Runs npm from the repository's scripts on Linux and Windows alike (design D8).
import { spawnSync } from 'node:child_process'

/** Arguments that pass through a shell unchanged: no spaces, quotes, or shell metacharacters. */
const SHELL_SAFE = /^[\w.:@+=/-]+$/

/**
 * `spawnSync` of npm with `args`.
 *
 * Under `npm run` (and in anything it starts, such as the unit tests), `npm_execpath` is npm's own
 * CLI script, so running it with the current Node avoids both a PATH lookup and spawning `npm.cmd`
 * on Windows, which Node 24 refuses without a shell (EINVAL). A non-JavaScript `npm_execpath`
 * (another package manager's binary) is not runnable that way.
 *
 * Otherwise npm comes from PATH; on Windows it is a `.cmd` shim and needs a shell, given one command
 * string because Node 24 deprecates arguments alongside `shell`. Each argument must then be
 * `SHELL_SAFE`, so joining cannot change its meaning; anything else throws before spawning.
 */
export function spawnNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath
  if (npmCli && /\.[cm]?js$/i.test(npmCli)) return spawnSync(process.execPath, [npmCli, ...args], options)
  if (process.platform === 'win32') {
    const unsafe = args.find((arg) => !SHELL_SAFE.test(arg))
    if (unsafe !== undefined) throw new Error(`refusing to pass ${JSON.stringify(unsafe)} to npm through the Windows shell`)
    return spawnSync(['npm', ...args].join(' '), { ...options, shell: true })
  }
  return spawnSync('npm', args, options)
}
