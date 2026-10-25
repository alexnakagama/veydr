import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RETENTION_NOTICE } from '../../src/renderer/src/LogView'
import {
  BATCH_INTERVAL_MS,
  BATCH_MAX_BYTES,
  BATCH_MAX_LINES,
  GLOBAL_MAX_BYTES,
  MAX_LINE_BYTES,
  MAX_UNACKED_BATCHES,
  MIN_REDACTED_SECRET_LENGTH,
  PARTIAL_LINE_FLUSH_MS,
  REDACTION_MARKER,
  RUN_MAX_BYTES,
  RUN_MAX_LINES,
} from '../../src/shared/logs/limits'

const doc = readFileSync(join(__dirname, '../../docs/logs.md'), 'utf8')
const section = (title: string): string => doc.split('\n## ').find((part) => part.startsWith(`${title}\n`)) ?? ''
const MiB = 1024 * 1024
const KiB = 1024

describe('docs/logs.md', () => {
  it('states the line handling limits of the code', () => {
    const text = section('What is captured')
    expect(text).toContain(`quiet for ${PARTIAL_LINE_FLUSH_MS} ms`)
    expect(text).toContain(`longer than ${MAX_LINE_BYTES / KiB} KiB (${MAX_LINE_BYTES.toLocaleString('en-US')} bytes)`)
    expect(text).toContain('**Order across the two streams is best effort.**')
  })

  it('states the retention limits of the code', () => {
    const text = section('How much is kept')
    expect(text).toContain(`| Lines per run | ${RUN_MAX_LINES.toLocaleString('en-US')} |`)
    expect(text).toContain(`| Text per run | ${RUN_MAX_BYTES / MiB} MiB |`)
    expect(text).toContain(`| Text of all runs together | ${GLOBAL_MAX_BYTES / MiB} MiB |`)
    expect(text).toContain('the current run and the one before it')
    expect(RETENTION_NOTICE).toContain(`${RUN_MAX_LINES.toLocaleString('en-US')} lines or ${RUN_MAX_BYTES / MiB} MiB`)
  })

  it('states the live delivery limits of the code', () => {
    const text = section('Live output and slow windows')
    expect(text).toContain(`at the latest ${BATCH_INTERVAL_MS} ms after a line is captured`)
    expect(text).toContain(`when ${BATCH_MAX_LINES.toLocaleString('en-US')} lines or ${BATCH_MAX_BYTES / KiB} KiB of text are waiting`)
    expect(text).toContain(`When ${MAX_UNACKED_BATCHES} batches wait for confirmation`)
  })

  it('states the redaction rules and limitations of the code', () => {
    const text = section('Secret values in output')
    expect(text).toContain(`with \`${REDACTION_MARKER}\``)
    expect(text).toContain(`Values shorter than ${MIN_REDACTED_SECRET_LENGTH} characters are not redacted`)
    expect(text).toContain(`at most ${MIN_REDACTED_SECRET_LENGTH - 1} characters of a secret can remain visible`)
    for (const limitation of ['transformed values', 'split values', 'partial values']) expect(text).toContain(limitation)
  })

  it('states that output is never written to disk', () => {
    expect(section('No log files')).toContain('Veydr never writes output to disk.')
  })
})
