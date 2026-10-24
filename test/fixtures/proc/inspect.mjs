// Inspect fixture: writes what it was started with — arguments, environment, working directory —
// as JSON to `--out`, then exits (or, with `--stay`, keeps running).
//
//   node inspect.mjs --out <file> [--stay] -- <arguments to report>...
import { writeFileSync } from 'node:fs'
import { stayAlive } from './ledger.mjs'

const separator = process.argv.indexOf('--')
const own = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator)
const reported = separator === -1 ? [] : process.argv.slice(separator + 1)
const out = own[own.indexOf('--out') + 1]
if (!own.includes('--out') || out === undefined) throw new Error('--out is required')

writeFileSync(out, JSON.stringify({ argv: reported, env: process.env, cwd: process.cwd(), pid: process.pid }))
if (own.includes('--stay')) stayAlive()
