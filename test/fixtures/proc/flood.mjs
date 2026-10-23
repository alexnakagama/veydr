// Output-flood fixture: writes `--bytes` of `--line-bytes`-long lines to stdout as fast as the
// reader accepts them, then writes `{bytes, ms}` to `--report` and exits. On Linux, writes to a
// pipe are synchronous in Node, so the elapsed time measures how fast the reader drains the pipe.
//
//   node flood.mjs --bytes N --report <file> [--line-bytes 100]
import { writeFileSync, writeSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    bytes: { type: 'string' },
    report: { type: 'string' },
    'line-bytes': { type: 'string', default: '100' },
  },
})
if (values.bytes === undefined || values.report === undefined) throw new Error('--bytes and --report are required')

const total = Number(values.bytes)
const lineBytes = Number(values['line-bytes'])
const chunk = Buffer.from(`${'x'.repeat(lineBytes - 1)}\n`.repeat(Math.max(1, Math.floor(65_536 / lineBytes))))

const started = performance.now()
let written = 0
while (written < total) {
  const length = Math.min(chunk.length, total - written)
  let offset = 0
  while (offset < length) offset += writeSync(1, chunk, offset, length - offset)
  written += length
}
const ms = performance.now() - started
writeFileSync(values.report, JSON.stringify({ bytes: written, ms }))
