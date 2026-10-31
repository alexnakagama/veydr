// What a probe driver and tree-worker.mjs share: the files through which a worker says it is ready,
// which they write atomically, so a reader never sees half a file.
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The worker script, which also runs the probes' child processes. */
export const WORKER = fileURLToPath(new URL('./tree-worker.mjs', import.meta.url))

/** How long a worker lives if nothing stops it, so a probe that fails leaves nothing running. */
export const WORKER_LIFETIME_MS = 180_000

export const specFile = (dir, name) => join(dir, `${name}.json`)
export const readyFile = (dir, name) => join(dir, `${name}.ready`)
export const errorFile = (dir, name) => join(dir, `${name}.error`)
/** Written by a worker with `signals` when it receives the signal; `signal` is `break` or `int`. */
export const markerFile = (dir, name, signal) => join(dir, `${name}.${signal}`)

export function writeAtomic(file, text) {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

/** The command line that runs a worker from cmd.exe or a package script. */
export const workerCommand = (spec) => [process.execPath, WORKER, spec].map((part) => `"${part}"`).join(' ')
