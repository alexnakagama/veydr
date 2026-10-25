import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { colorCss, spanStyle } from '../../src/renderer/src/ansi-style'
import { formatCaptureTime, LogView, REDACTION_NOTICE, RETENTION_NOTICE } from '../../src/renderer/src/LogView'
import { connectLogStore, createLogViewStore, filterItems, plainText, utf8Length, type LogItem } from '../../src/renderer/src/state/logs'
import { DEFAULT_STYLE } from '../../src/shared/ansi'
import type { ApiResult, LogBatch, LogLine, ReadLogsRequest, ReadLogsResponse, VeydrApi } from '../../src/shared/api'
import { RUN_MAX_LINES } from '../../src/shared/logs/limits'

const COMMAND = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const RUN = '00000000-0000-4000-8000-000000000001'
const OTHER_RUN = '00000000-0000-4000-8000-000000000002'

const line = (seq: number, text = `line ${seq}`, stream: LogLine['stream'] = 'stdout'): LogLine => ({ seq, stream, at: 1_700_000_000_000 + seq, text, truncated: false })
const lines = (from: number, to: number): LogLine[] => Array.from({ length: to - from + 1 }, (_, i) => line(from + i))
const batch = (batchId: number, items: LogLine[], skipped: LogBatch['skipped'] = null, runId = RUN): LogBatch => ({
  commandId: COMMAND,
  runId,
  seq: items.at(-1)?.seq ?? skipped?.toSeq ?? 1,
  batchId,
  lines: items,
  skipped,
})
const seqs = (items: readonly LogItem[]): (number | string)[] => items.map((item) => (item.kind === 'line' ? item.line.seq : `${item.reason}:${item.fromSeq}-${item.toSeq}`))
const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

/** A fake `logs.read`/`logs.clear` over retained lines `[first, next)`, answering when released. */
function fakeMain(retained: LogLine[], options: { discarded?: number; nextSeq?: number } = {}) {
  const reads: ReadLogsRequest[] = []
  const waiting: (() => void)[] = []
  let hold = false
  const api = {
    read: (request: ReadLogsRequest): Promise<ApiResult<ReadLogsResponse>> => {
      reads.push(request)
      const answer = (): ApiResult<ReadLogsResponse> => {
        if (request.runId !== RUN) return { ok: false, error: { code: 'not_found', message: 'No output is retained for this run.' } }
        const page = retained.filter((l) => l.seq >= request.fromSeq).slice(0, request.limit)
        const nextSeq = options.nextSeq ?? (retained.at(-1)?.seq ?? 0) + 1
        return { ok: true, value: { runId: RUN, lines: page, firstRetainedSeq: retained[0]?.seq ?? null, nextSeq, discarded: options.discarded ?? 0 } }
      }
      if (!hold) return Promise.resolve(answer())
      return new Promise((resolve) => waiting.push(() => resolve(answer())))
    },
    clear: (): Promise<ApiResult<{ clearedThroughSeq: number }>> => Promise.resolve({ ok: true, value: { clearedThroughSeq: retained.at(-1)?.seq ?? 0 } }),
  }
  return {
    api,
    reads,
    hold: () => {
      hold = true
    },
    release: () => {
      hold = false
      for (const go of waiting.splice(0)) go()
    },
    setRetained: (next: LogLine[]) => {
      retained = next
    },
  }
}

describe('log view store', () => {
  it('[spec:process-logs/user-interface-reloaded] loads retained lines, then applies batches held meanwhile without duplicates or reordering', async () => {
    const main = fakeMain(lines(1, 5))
    const store = createLogViewStore(main.api)
    main.hold()
    store.show(COMMAND, RUN)
    expect(store.getState().status).toBe('loading')
    // Batches that overlap what the read returns, and one after it, arrive before the read answers.
    store.receive(batch(1, lines(4, 6)))
    store.receive(batch(2, lines(7, 8)))
    main.release()
    await flush()
    expect(store.getState().status).toBe('ready')
    expect(seqs(store.getState().items)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // Later batches continue; repeats are ignored.
    store.receive(batch(3, lines(8, 9)))
    expect(seqs(store.getState().items)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(store.getState().appended).toBe(1)
  })

  it('does not chase a flooding run while loading, and holds a bounded number of batches (L6-01)', async () => {
    // Every page is full and the run keeps growing: each read sees 5,000 more lines.
    let produced = 20_000
    const reads: number[] = []
    let deliver: () => void = () => undefined
    const api = {
      read: (request: ReadLogsRequest): Promise<ApiResult<ReadLogsResponse>> => {
        reads.push(request.fromSeq)
        produced += 5_000
        const first = produced - RUN_MAX_LINES + 1
        const from = Math.max(request.fromSeq, first)
        return new Promise((resolve) => {
          deliver = () => resolve({ ok: true, value: { runId: RUN, lines: lines(from, from + 4_999), firstRetainedSeq: first, nextSeq: produced + 1, discarded: first - 1 } })
        })
      },
      clear: (): Promise<ApiResult<{ clearedThroughSeq: number }>> => Promise.reject(new Error('unused')),
    }
    const store = createLogViewStore(api)
    store.show(COMMAND, RUN)
    for (let page = 0; page < 10 && store.getState().status === 'loading'; page++) {
      // Live batches keep arriving meanwhile: far more than the view holds.
      for (let b = 0; b < 30; b++) store.receive(batch(page * 100 + b + 1, lines(100_000 + (page * 30 + b) * 1_000 + 1, 100_000 + (page * 30 + b + 1) * 1_000)))
      deliver()
      await flush()
    }
    expect(store.getState().status).toBe('ready')
    expect(reads.length).toBeLessThanOrEqual(3)
    const items = store.getState().items
    expect(items.filter((i) => i.kind === 'line').length).toBeLessThanOrEqual(RUN_MAX_LINES)
    // Strictly increasing; what was neither read nor held is a fetchable gap.
    const ranges = items.map((i) => (i.kind === 'line' ? [i.line.seq, i.line.seq] : [i.fromSeq, i.toSeq]))
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]?.[0]).toBe((ranges[i - 1]?.[1] ?? 0) + 1)
    expect(items.some((i) => i.kind === 'gap' && i.reason === 'skipped')).toBe(true)
  })

  it('stops reading once held batches continue where the pages reached', async () => {
    const main = fakeMain(lines(1, 12_000), { nextSeq: 12_001 })
    const store = createLogViewStore(main.api)
    main.hold()
    store.show(COMMAND, RUN)
    store.receive(batch(1, lines(4_000, 12_500)))
    main.release()
    await flush()
    await flush()
    expect(main.reads.map((r) => r.fromSeq)).toEqual([1])
    expect(seqs(store.getState().items).at(-1)).toBe(12_500)
  })

  it('counts text in UTF-8 bytes like main', () => {
    expect([utf8Length('abc'), utf8Length('ä'), utf8Length('€'), utf8Length('😀'), utf8Length('\ud800')]).toEqual([3, 2, 3, 4, 3])
  })

  it('reads in pages and marks lines evicted between pages as no longer retained', async () => {
    const main = fakeMain(lines(1, 6000), { nextSeq: 6001 })
    const original = main.api.read
    // Between the pages, lines up to 5100 are evicted.
    main.api.read = (request) => {
      if (request.fromSeq > 1) main.setRetained(lines(5101, 6000))
      return original(request)
    }
    const store = createLogViewStore(main.api)
    store.show(COMMAND, RUN)
    await flush()
    await flush()
    expect(main.reads.map((r) => r.fromSeq)).toEqual([1, 5001])
    const items = store.getState().items
    expect(seqs(items.slice(4999, 5002))).toEqual([5000, 'discarded:5001-5100', 5101])
    expect(items.filter((i) => i.kind === 'line')).toHaveLength(5900)
  })

  it('[spec:process-logs/slow-view] shows a marker for skipped lines and fetches those still retained on request', async () => {
    const main = fakeMain(lines(1, 2))
    const store = createLogViewStore(main.api)
    store.show(COMMAND, RUN)
    await flush()
    store.receive(batch(1, [line(9)], { fromSeq: 3, toSeq: 8 }))
    expect(seqs(store.getState().items)).toEqual([1, 2, 'skipped:3-8', 9])
    // 3 and 4 were evicted meanwhile; 5–8 are retained.
    main.setRetained(lines(5, 9))
    const gap = store.getState().items[2]
    if (gap?.kind !== 'gap') throw new Error('expected a gap')
    await store.expand(gap)
    expect(seqs(store.getState().items)).toEqual([1, 2, 'discarded:3-4', 5, 6, 7, 8, 9])
  })

  it('ignores batches of other runs and a skipped range already covered', async () => {
    const store = createLogViewStore(fakeMain(lines(1, 3)).api)
    store.show(COMMAND, RUN)
    await flush()
    store.receive(batch(1, lines(1, 10), null, OTHER_RUN))
    store.receive(batch(2, [], { fromSeq: 1, toSeq: 3 }))
    expect(seqs(store.getState().items)).toEqual([1, 2, 3])
    // A gap in seq without a reported range is shown as skipped (fetchable), never silently.
    store.receive(batch(3, [line(6)]))
    expect(seqs(store.getState().items)).toEqual([1, 2, 3, 'skipped:4-5', 6])
  })

  it('[spec:process-logs/clear] clears the view and ignores lines up to the cleared seq still on their way', async () => {
    const main = fakeMain(lines(1, 4))
    const store = createLogViewStore(main.api)
    store.show(COMMAND, RUN)
    await flush()
    expect(await store.clear()).toEqual({ ok: true, value: null })
    expect(store.getState().items).toEqual([])
    expect(store.getState().clears).toBe(1)
    store.receive(batch(1, lines(3, 5)))
    expect(seqs(store.getState().items)).toEqual([5])
  })

  it('keeps lines captured after the clear that arrived while it was requested (L6-06)', async () => {
    const main = fakeMain(lines(1, 4))
    let answer: () => void = () => undefined
    main.api.clear = () => new Promise((resolve) => (answer = () => resolve({ ok: true, value: { clearedThroughSeq: 4 } })))
    const store = createLogViewStore(main.api)
    store.show(COMMAND, RUN)
    await flush()
    const clearing = store.clear()
    store.receive(batch(1, lines(5, 6)))
    store.receive(batch(2, [], { fromSeq: 7, toSeq: 8 }))
    answer()
    await clearing
    expect(seqs(store.getState().items)).toEqual([5, 6, 'skipped:7-8'])
  })

  it('reports a failed clear and keeps the lines', async () => {
    const main = fakeMain(lines(1, 2))
    main.api.clear = () => Promise.resolve({ ok: false as const, error: { code: 'not_found' as const, message: 'No output is retained for this run.' } })
    const store = createLogViewStore(main.api)
    store.show(COMMAND, RUN)
    await flush()
    expect(await store.clear()).toEqual({ ok: false, message: 'No output is retained for this run.' })
    expect(seqs(store.getState().items)).toEqual([1, 2])
  })

  it('[spec:process-logs/retention-limit-reached] holds at most the per-run line limit and reports discarded lines', async () => {
    const store = createLogViewStore(fakeMain(lines(1, 1), { discarded: 7 }).api)
    store.show(COMMAND, RUN)
    await flush()
    expect(store.getState().discarded).toBe(7)
    store.receive(batch(1, lines(2, RUN_MAX_LINES + 11)))
    const items = store.getState().items
    expect(items).toHaveLength(RUN_MAX_LINES)
    expect(seqs([items[0] as LogItem])).toEqual([12])
    expect(store.getState().discarded).toBe(7 + 11)
  })

  it('shows a run main does not retain yet (still starting) as empty and fills it from live batches', async () => {
    const main = fakeMain(lines(1, 2))
    const store = createLogViewStore(main.api)
    main.hold()
    store.show(COMMAND, OTHER_RUN)
    store.receive(batch(1, lines(1, 2), null, OTHER_RUN))
    main.release()
    await flush()
    expect(store.getState()).toMatchObject({ status: 'ready', error: null })
    expect(seqs(store.getState().items)).toEqual([1, 2])
    store.receive(batch(2, [line(3)], null, OTHER_RUN))
    expect(seqs(store.getState().items)).toEqual([1, 2, 3])
  })

  it('reports a failed read, and switches runs cleanly', async () => {
    const main = fakeMain(lines(1, 2))
    main.api.read = () => Promise.resolve({ ok: false as const, error: { code: 'internal' as const, message: 'Internal error' } })
    const store = createLogViewStore(main.api)
    store.show(COMMAND, RUN)
    await flush()
    expect(store.getState()).toMatchObject({ status: 'error', error: 'Output could not be loaded: Internal error' })
    store.show(COMMAND, null)
    expect(store.getState()).toMatchObject({ status: 'idle', items: [] })
  })

  it('ignores a read for an earlier run that answers late', async () => {
    const main = fakeMain(lines(1, 2))
    const store = createLogViewStore(main.api)
    main.hold()
    store.show(COMMAND, RUN)
    store.show(COMMAND, OTHER_RUN)
    main.release()
    await flush()
    expect(store.getState()).toMatchObject({ runId: OTHER_RUN, status: 'ready', items: [] })
  })

  it('acknowledges every batch after handling it, also of runs not shown', () => {
    const acks: number[] = []
    let deliver: (b: LogBatch) => void = () => undefined
    const api = {
      onBatch: (listener: (b: LogBatch) => void) => {
        deliver = listener
        return () => undefined
      },
      ack: ({ batchId }: { batchId: number }) => {
        acks.push(batchId)
        return Promise.resolve({ ok: true as const, value: null })
      },
    } as unknown as Pick<VeydrApi['logs'], 'onBatch' | 'ack'>
    connectLogStore(createLogViewStore(fakeMain([]).api), api)
    deliver(batch(5, [line(1)], null, OTHER_RUN))
    deliver(batch(6, [line(2)]))
    expect(acks).toEqual([5, 6])
  })
})

describe('log filters and copying', () => {
  const items: LogItem[] = [
    { kind: 'line', line: line(1, 'Server \u001b[32mREADY\u001b[0m on :3000') },
    { kind: 'line', line: line(2, 'warning: slow', 'stderr') },
    { kind: 'gap', fromSeq: 3, toSeq: 4, reason: 'skipped' },
    { kind: 'line', line: line(5, 'ready again') },
  ]

  it('[spec:process-logs/filter-by-text] shows only lines containing the text, ignoring case and escape sequences', () => {
    expect(seqs(filterItems(items, { text: 'ready', stream: 'all' }))).toEqual([1, 'skipped:3-4', 5])
    // The escape sequence between "READY" and " on" is not part of the text.
    expect(seqs(filterItems(items, { text: 'ready on', stream: 'all' }))).toEqual([1, 'skipped:3-4'])
    expect(seqs(filterItems(items, { text: '', stream: 'stderr' }))).toEqual([2, 'skipped:3-4'])
    expect(filterItems(items, { text: '', stream: 'all' })).toBe(items)
  })

  it('[spec:process-logs/copy] copies lines as plain text without escape sequences or markers', () => {
    expect(plainText(items)).toBe('Server READY on :3000\nwarning: slow\nready again')
  })
})

describe('log view rendering', () => {
  const render = async (retained: LogLine[]): Promise<string> => {
    const store = createLogViewStore(fakeMain(retained).api)
    store.show(COMMAND, RUN)
    await flush()
    return renderToStaticMarkup(createElement(LogView, { store, commandName: 'api', onClear: () => undefined }))
  }

  it('states that redaction is best effort, and shows an empty state', async () => {
    const html = await render([])
    expect(html).toContain(REDACTION_NOTICE)
    expect(REDACTION_NOTICE).toMatch(/transformed, split, or partial values are not detected/)
    expect(html).toContain('No output yet.')
  })

  it('formats capture times as local HH:MM:SS.mmm', () => {
    const at = new Date(2026, 9, 24, 9, 5, 7, 42).getTime()
    expect(formatCaptureTime(at)).toBe('09:05:07.042')
  })

  it('maps SGR colors to CSS and leaves the default style unstyled', () => {
    expect(spanStyle(DEFAULT_STYLE)).toBeUndefined()
    expect(colorCss({ kind: 'palette', index: 1 })).toBe('#e06c75')
    expect(colorCss({ kind: 'palette', index: 196 })).toBe('rgb(255, 0, 0)')
    expect(colorCss({ kind: 'palette', index: 244 })).toBe('rgb(128, 128, 128)')
    expect(colorCss({ kind: 'rgb', r: 1, g: 2, b: 3 })).toBe('rgb(1, 2, 3)')
    expect(spanStyle({ ...DEFAULT_STYLE, fg: { kind: 'palette', index: 2 }, bold: true, inverse: true })).toEqual({ color: 'var(--log-bg)', backgroundColor: '#98c379', fontWeight: 700 })
  })

  it('exposes the retention notice text with the documented limits', () => {
    expect(RETENTION_NOTICE).toBe('Older output was discarded: Veydr keeps the newest 10,000 lines or 8 MiB of each run.')
  })

  it('never renders markup from strings: no HTML injection APIs in the renderer', () => {
    const root = join(__dirname, '../../src/renderer/src')
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []))
    for (const file of files(root)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/)
    }
  })
})
