// Copies one file to stdout and another to stderr, byte for byte, then exits with `--exit-code`, so
// a test can check that a command's output and exit code reach Veydr unchanged
// (add-windows-process-supervision design D2).
//
//   node output.mjs --marker <id> --dir <dir> --stdout <file> --stderr <file> --exit-code <n>
//
// `--marker` and `--dir` are those of every Windows fixture; they are not used here.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    marker: { type: 'string' },
    dir: { type: 'string' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    'exit-code': { type: 'string', default: '0' },
  },
})
if (values.stdout === undefined || values.stderr === undefined) throw new Error('--stdout and --stderr are required')

let pending = 2
const done = () => {
  if (--pending === 0) process.exit(Number(values['exit-code']))
}
process.stdout.write(readFileSync(values.stdout), done)
process.stderr.write(readFileSync(values.stderr), done)
