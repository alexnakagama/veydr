import { useVirtualizer } from '@tanstack/react-virtual'
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { LogLine, LogStream } from '../../shared/api'
import { parseAnsi, type AnsiSpan } from '../../shared/ansi'
import { MAX_LINE_BYTES, REDACTION_MARKER, RUN_MAX_BYTES, RUN_MAX_LINES } from '../../shared/logs/limits'
import { spanStyle } from './ansi-style'
import { filterItems, gapSize, plainText, searchTextOf, type LogGap, type LogItem, type LogViewStore } from './state/logs'
import { useStore } from './state/store'

/** Height of one row in pixels; rows never wrap (long lines scroll horizontally). */
export const LOG_ROW_HEIGHT = 20
/** Width of a row besides its text, in characters: time, stream, truncation marker. */
const LINE_EXTRA_CH = 48

/** Shown with the output (spec: best-effort secret redaction). */
export const REDACTION_NOTICE = `Secret values of this command are replaced with ${REDACTION_MARKER} on a best-effort basis: transformed, split, or partial values are not detected.`

export const RETENTION_NOTICE = `Older output was discarded: Veydr keeps the newest ${RUN_MAX_LINES.toLocaleString('en-US')} lines or ${RUN_MAX_BYTES / (1024 * 1024)} MiB of each run.`

const streamLabels: Readonly<Record<LogStream, { short: string; long: string }>> = {
  stdout: { short: 'out', long: 'standard output' },
  stderr: { short: 'err', long: 'standard error' },
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

/** Capture time as local `HH:MM:SS.mmm`. */
export function formatCaptureTime(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const spanCache = new WeakMap<LogLine, AnsiSpan[]>()
function spansOf(line: LogLine): AnsiSpan[] {
  let spans = spanCache.get(line)
  if (spans === undefined) {
    spans = parseAnsi(line.text)
    spanCache.set(line, spans)
  }
  return spans
}

const plural = (count: number, word: string): string => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`

/**
 * Puts `text` on the clipboard as plain text. Uses the copy command of a user action, which needs
 * no clipboard permission (Veydr denies every permission request).
 */
function copyToClipboard(text: string): boolean {
  const onCopy = (event: globalThis.ClipboardEvent): void => {
    event.clipboardData?.setData('text/plain', text)
    event.preventDefault()
  }
  document.addEventListener('copy', onCopy)
  try {
    return document.execCommand('copy')
  } finally {
    document.removeEventListener('copy', onCopy)
  }
}

function LineRow({ line, index }: { line: LogLine; index: number }): JSX.Element {
  const stream = streamLabels[line.stream]
  return (
    <div className={`log-row log-${line.stream}`} data-index={index} data-seq={line.seq} data-testid="log-line">
      <span className="log-meta">
        <time className="log-time" dateTime={new Date(line.at).toISOString()}>
          {formatCaptureTime(line.at)}
        </time>
        <span className="log-stream" title={stream.long} data-testid="log-stream">
          {stream.short}
        </span>
      </span>
      <span className="log-text" data-testid="log-text">
        {spansOf(line).map((span, i) => (
          // Text only: React renders it as a text node, never as markup.
          <span key={i} style={spanStyle(span.style)}>
            {span.text}
          </span>
        ))}
      </span>
      {line.truncated && (
        <span className="log-truncated" data-testid="log-truncated" title={`The line was longer than ${MAX_LINE_BYTES / 1024} KiB; the rest was dropped.`}>
          … truncated at {MAX_LINE_BYTES / 1024} KiB
        </span>
      )}
    </div>
  )
}

function GapRow({ gap, index, onExpand }: { gap: LogGap; index: number; onExpand: (gap: LogGap) => void }): JSX.Element {
  const count = plural(gapSize(gap), 'line')
  return (
    <div className={`log-row log-gap log-gap-${gap.reason}`} data-index={index} data-testid="log-gap" data-reason={gap.reason} data-from={gap.fromSeq} data-to={gap.toSeq}>
      {gap.reason === 'skipped' ? (
        <>
          <span>{count} skipped in the live view</span>
          <button type="button" className="log-gap-action" onClick={() => onExpand(gap)}>
            Show
          </button>
        </>
      ) : (
        <span>{count} no longer retained</span>
      )}
    </div>
  )
}

export interface LogViewProps {
  readonly store: LogViewStore
  readonly commandName: string
  /** Asks to clear the shown run's output (after a confirmation). */
  readonly onClear: () => void
}

/**
 * Output of the selected command's current run (spec: process-logs): stream and capture time per
 * line, text-only rendering of styled output, text and stream filter, follow/pause with a
 * new-output indicator, copy as plain text, and clear. Rows are virtualized.
 */
export function LogView({ store, commandName, onClear }: LogViewProps): JSX.Element {
  const state = useStore(store)
  const [filterText, setFilterText] = useState('')
  const [stream, setStream] = useState<LogStream | 'all'>('all')
  const appliedText = useDeferredValue(filterText)
  /**
   * Following is paused for `runId` since `state.appended` was `at` (counted since clear number
   * `clears`); a new run (start, restart) is followed again.
   */
  const [paused, setPaused] = useState<{ readonly runId: string | null; readonly at: number; readonly clears: number } | null>(null)
  const following = paused === null || paused.runId !== state.runId
  const [copyNote, setCopyNote] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => filterItems(state.items, { text: appliedText, stream }), [state.items, appliedText, stream])
  const filtered = appliedText !== '' || stream !== 'all'

  // Veydr does not use the React Compiler, and the virtualizer's functions are only called during
  // this component's render, never passed to memoized children.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LOG_ROW_HEIGHT,
    overscan: 20,
    getItemKey: (index) => {
      const item = visible[index]
      if (item === undefined) return index
      return item.kind === 'line' ? `l${item.line.seq}` : `g${item.fromSeq}`
    },
  })

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (following && element !== null) element.scrollTop = element.scrollHeight
  }, [following, visible])

  const pause = (): void => setPaused({ runId: state.runId, at: state.appended, clears: state.clears })
  const follow = (): void => setPaused(null)

  const onScroll = (): void => {
    const element = scrollRef.current
    if (element === null) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= LOG_ROW_HEIGHT
    // Scrolling up pauses following; scrolling back to the end resumes it.
    if (following && !atBottom) pause()
    else if (!following && atBottom) follow()
  }

  const copyVisible = (): void => {
    const lines = visible.filter((item) => item.kind === 'line').length
    const missing = visible.reduce((sum, item) => sum + (item.kind === 'gap' ? gapSize(item) : 0), 0)
    const note = missing === 0 ? `Copied ${plural(lines, 'line')}.` : `Copied ${plural(lines, 'line')} (${plural(missing, 'skipped or discarded line')} not included).`
    setCopyNote(copyToClipboard(plainText(visible)) ? note : 'Copying failed.')
  }

  /**
   * Copying a selection in the output yields plain text: within one line, the selected text;
   * otherwise whole lines, including lines between the ends of the selection that are not
   * rendered (rows are virtualized). A selection reaching beyond the list copies every shown line
   * from where it starts to where it ends. Listens on the document, because a copy event goes to
   * the selection's common ancestor, which is outside the list for such a selection (L6-07).
   */
  useEffect(() => {
    const onCopy = (event: globalThis.ClipboardEvent): void => {
      const text = selectedOutput()
      if (text === null || event.clipboardData === null) return
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
    }
    const selectedOutput = (): string | null => {
      const selection = window.getSelection()
      const list = scrollRef.current
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0 || list === null) return null
      const range = selection.getRangeAt(0)
      if (!range.intersectsNode(list)) return null
      const elementOf = (node: Node): HTMLElement | null => (node instanceof HTMLElement ? node : node.parentElement)
      const rowOf = (node: Node): HTMLElement | null => {
        const row = elementOf(node)?.closest<HTMLElement>('[data-index]') ?? null
        return row !== null && list.contains(row) ? row : null
      }
      const startRow = rowOf(range.startContainer)
      const endRow = rowOf(range.endContainer)
      const from = startRow === null ? 0 : Number(startRow.dataset['index'])
      const to = endRow === null ? visible.length - 1 : Number(endRow.dataset['index'])
      const inText = (node: Node): boolean => Boolean(elementOf(node)?.closest('.log-text'))
      return startRow !== null && startRow === endRow && inText(range.startContainer) && inText(range.endContainer) ? selection.toString() : plainText(visible.slice(from, to + 1))
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [visible])

  /** Ctrl+A (or Cmd+A) in the output selects the output only, which copies every shown line. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key.toLowerCase() !== 'a' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    const rows = scrollRef.current?.querySelector('.log-rows')
    if (rows === null || rows === undefined) return
    event.preventDefault()
    const range = document.createRange()
    range.selectNodeContents(rows)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const newLines = paused === null || following ? 0 : Math.max(0, paused.clears === state.clears ? state.appended - paused.at : state.appended)
  // Width of the widest shown line, so the horizontal scroll range does not change while scrolling
  // vertically (rows outside the viewport are not rendered). Monospace: one `ch` per character.
  const widest = useMemo(() => visible.reduce((max, item) => (item.kind === 'line' ? Math.max(max, searchTextOf(item.line).length) : max), 0), [visible])
  const virtualItems = virtualizer.getVirtualItems()
  const start = virtualItems[0]?.start ?? 0
  const end = virtualItems.at(-1)?.end ?? 0

  let empty: string | null = null
  if (state.status === 'idle') empty = 'No output yet. Start the command to see its output here.'
  else if (state.status === 'loading') empty = 'Loading output…'
  else if (state.status === 'error') empty = state.error
  else if (visible.length === 0) empty = filtered ? 'No line matches the filter.' : 'No output yet.'

  return (
    <section className="log-panel" aria-labelledby="log-panel-title" data-testid="log-view">
      <div className="log-toolbar">
        <h2 id="log-panel-title" className="log-title">
          Output <span className="muted">— {commandName}</span>
        </h2>
        <input
          type="search"
          className="log-filter"
          aria-label="Filter output"
          placeholder="Filter output"
          value={filterText}
          spellCheck={false}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <select className="log-select" aria-label="Streams shown" value={stream} onChange={(e) => setStream(e.target.value as LogStream | 'all')}>
          <option value="all">Both streams</option>
          <option value="stdout">Standard output</option>
          <option value="stderr">Standard error</option>
        </select>
        <button type="button" className="command-action" aria-pressed={!following} onClick={following ? pause : follow}>
          {following ? 'Pause' : 'Follow'}
        </button>
        <button type="button" className="command-action" onClick={copyVisible} disabled={visible.length === 0}>
          Copy visible
        </button>
        <button type="button" className="command-action" onClick={onClear} disabled={state.runId === null || state.status !== 'ready'}>
          Clear
        </button>
      </div>
      {state.discarded > 0 && (
        <p className="log-note" data-testid="log-discarded">
          {RETENTION_NOTICE}
        </p>
      )}
      {state.liveError !== null && (
        <p className="log-note log-note-error" role="alert">
          Live output is unavailable: {state.liveError}
        </p>
      )}
      {state.fetchError !== null && (
        <p className="log-note log-note-error" role="alert">
          {state.fetchError}
        </p>
      )}
      <div
        ref={scrollRef}
        className="log-scroll"
        role="log"
        aria-live="off"
        aria-label={`Output of ${commandName}`}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        data-testid="log-scroll"
        data-applied-filter={appliedText}
        data-following={following}
      >
        {empty !== null ? (
          <p className="log-empty" data-testid="log-empty">
            {empty}
          </p>
        ) : (
          <div className="log-rows" style={{ paddingTop: start, paddingBottom: Math.max(0, virtualizer.getTotalSize() - end), minWidth: `max(100%, calc(${widest + LINE_EXTRA_CH}ch + 24px))` }}>
            {virtualItems.map((row) => {
              const item: LogItem | undefined = visible[row.index]
              if (item === undefined) return null
              return item.kind === 'line' ? (
                <LineRow key={row.key} line={item.line} index={row.index} />
              ) : (
                <GapRow key={row.key} gap={item} index={row.index} onExpand={(gap) => void store.expand(gap)} />
              )
            })}
          </div>
        )}
      </div>
      <div className="log-footer">
        {newLines > 0 && (
          <button type="button" className="log-new-output" data-testid="log-new-output" onClick={follow}>
            {plural(newLines, 'new line')} — follow
          </button>
        )}
        {copyNote !== null && (
          <span className="muted" role="status">
            {copyNote}
          </span>
        )}
        <span className="muted log-redaction" data-testid="log-redaction-notice">
          {REDACTION_NOTICE}
        </span>
      </div>
    </section>
  )
}
