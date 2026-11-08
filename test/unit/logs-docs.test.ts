import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_ANSI_CODE_PAGES } from '../../src/main/platform/windows/code-page'
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

  it('[spec:process-logs/ansi-output-on-windows] states the Windows output decoding, as not yet reachable from the app', () => {
    const text = section('Windows (not yet available)')
    expect(text).toContain('**Not yet reachable from the app.**')
    // The UTF-8 console, and what happens when it cannot be set.
    expect(text).toContain('output code page is set to UTF-8 (65001) before the command runs')
    expect(text).toContain('`process.windows-console-not-utf8`')
    // The ANSI fallback, with every code page of the table.
    expect(text).toContain('decoded with the system\'s **ANSI code page**')
    for (const codePage of KNOWN_ANSI_CODE_PAGES.filter((cp) => cp < 1251 || cp > 1257)) expect(text).toContain(String(codePage))
    // OEM bytes written straight to a pipe, and the remedies.
    expect(text).toContain('### Programs that write OEM bytes to a pipe')
    expect(text).toContain('`PYTHONUTF8=1`')
    expect(text).toContain('`chcp 65001 >nul`')
    // A multibyte character cut at the line limit.
    expect(text).toContain(`The ${MAX_LINE_BYTES / KiB} KiB limit applies to the bytes as the command wrote them, and to the shown text in UTF-8.`)
    expect(text).toContain('A character cut in two at the limit is dropped, never shown in part')
  })

  it('states that output is never written to disk', () => {
    expect(section('No log files')).toContain('Veydr never writes output to disk.')
  })
})
