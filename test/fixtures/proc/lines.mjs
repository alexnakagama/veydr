// Paced line producer: writes `--rate` lines per second of `--line-bytes` bytes each (newline
// included) to stdout for `--seconds`, or `--count` lines in total, then writes
// `{lines, ms}` to `--report` (if given) and exits. Each line starts with its 1-based number,
// zero-padded to 9 digits, so a consumer can check order and completeness.
//
// Writes are synchronous (blocking on a full pipe), so a slow reader slows the producer: the
// achieved rate measures how much output the reader let through. The producer catches up after a
// stall, as fast as the reader allows, without exceeding the target count for the elapsed time.
//
//   node lines.mjs --rate 50000 --seconds 60 [--line-bytes 100] [--count N] [--report <file>] [--stderr-every N]
import { writeFileSync, writeSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    rate: { type: 'string', default: '1000' },
    seconds: { type: 'string' },
    count: { type: 'string' },
    'line-bytes': { type: 'string', default: '100' },
    report: { type: 'string' },
    'stderr-every': { type: 'string', default: '0' },
  },
})

const rate = Number(values.rate)
const lineBytes = Math.max(11, Number(values['line-bytes']))
const limit = values.count === undefined ? Number.POSITIVE_INFINITY : Number(values.count)
const seconds = values.seconds === undefined ? Number.POSITIVE_INFINITY : Number(values.seconds)
const stderrEvery = Number(values['stderr-every'])
if (!Number.isFinite(limit) && !Number.isFinite(seconds)) throw new Error('--seconds or --count is required')

const filler = 'x'.repeat(lineBytes - 11)
const line = (n) => `${String(n).padStart(9, '0')} ${filler}\n`
const sleeper = new Int32Array(new SharedArrayBuffer(4))

const started = performance.now()
let written = 0
for (;;) {
  const elapsed = performance.now() - started
  if (elapsed >= seconds * 1000 || written >= limit) break
  const due = Math.min(limit, Math.floor((elapsed / 1000) * rate))
  if (due <= written) {
    Atomics.wait(sleeper, 0, 0, 1)
    continue
  }
  let out = ''
  let err = ''
  // At most 64 KiB per write, so the deadline is checked often.
  const end = Math.min(due, written + Math.max(1, Math.floor(65_536 / lineBytes)))
  for (let n = written + 1; n <= end; n++) {
    if (stderrEvery > 0 && n % stderrEvery === 0) err += line(n)
    else out += line(n)
  }
  if (out !== '') {
    const buffer = Buffer.from(out)
    let offset = 0
    while (offset < buffer.length) offset += writeSync(1, buffer, offset, buffer.length - offset)
  }
  if (err !== '') {
    const buffer = Buffer.from(err)
    let offset = 0
    while (offset < buffer.length) offset += writeSync(2, buffer, offset, buffer.length - offset)
  }
  written = end
}
const ms = performance.now() - started
if (values.report !== undefined) writeFileSync(values.report, JSON.stringify({ lines: written, ms }))
