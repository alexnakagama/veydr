import type { ApiResult, LogBatch, LogLine, LogStream, ReadLogsResponse, Unsubscribe, VeydrApi } from '../../../shared/api'
import { stripAnsi } from '../../../shared/ansi'
import { MAX_LOG_READ_LIMIT, RUN_MAX_BYTES, RUN_MAX_LINES } from '../../../shared/logs/limits'
import type { Outcome } from './actions'
import { createStore, UNREACHABLE, type Store } from './store'

/** A captured line, or lines of the run that the view does not hold. */
export type LogItem = { readonly kind: 'line'; readonly line: LogLine } | LogGap

/**
 * Lines the view does not hold. `skipped`: left out of live delivery while the view was behind;
 * they can be fetched while they are retained. `discarded`: no longer retained.
 */
export interface LogGap {
  readonly kind: 'gap'
  readonly fromSeq: number
  readonly toSeq: number
  readonly reason: 'skipped' | 'discarded'
}

export interface LogViewState {
  readonly commandId: string | null
  /** The run shown; `null` if the command has not run in this session. */
  readonly runId: string | null
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** Why the run's output cannot be shown (e.g. it is no longer retained). */
  readonly error: string | null
  /** Why live output cannot be received. */
  readonly liveError: string | null
  /** Why fetching skipped lines failed. */
  readonly fetchError: string | null
  /** The shown run's items, oldest first; a new array whenever they change. */
  readonly items: readonly LogItem[]
  /** Lines appended since the run was shown or cleared (counts new output while following is paused). */
  readonly appended: number
  /** Older lines of the run that are no longer available (retention limits in main or in the view). */
  readonly discarded: number
  /** Increases with every successful clear (`appended` restarts at 0 then). */
  readonly clears: number
}

export interface LogViewStore extends Store<LogViewState> {
  /** Shows `runId` of `commandId` (`null`: nothing to show): loads its retained lines, then follows live batches. */
  readonly show: (commandId: string | null, runId: string | null) => void
  /** Handles a live batch (of any run; only the shown run's are kept). */
  readonly receive: (batch: LogBatch) => void
  readonly liveFailed: (message: string) => void
  /** Discards the shown run's retained output in main and in the view; capture continues. */
  readonly clear: () => Promise<Outcome<null>>
  /** Fetches the lines of a `skipped` gap that are still retained. */
  readonly expand: (gap: LogGap) => Promise<void>
}

type Api = Pick<VeydrApi['logs'], 'read' | 'clear'>

/** Lowercased text without escape sequences, cached per line, for the text filter. */
const searchable = new WeakMap<LogLine, string>()
export function searchTextOf(line: LogLine): string {
  let text = searchable.get(line)
  if (text === undefined) {
    text = stripAnsi(line.text).toLowerCase()
    searchable.set(line, text)
  }
  return text
}

export interface LogFilter {
  /** Text the line must contain, ignoring case; empty: any. */
  readonly text: string
  readonly stream: LogStream | 'all'
}

/** Items shown for `filter`: matching lines; gaps are always shown (they may hide matches). */
export function filterItems(items: readonly LogItem[], filter: LogFilter): readonly LogItem[] {
  const needle = filter.text.toLowerCase()
  if (needle === '' && filter.stream === 'all') return items
  return items.filter((item) => item.kind === 'gap' || ((filter.stream === 'all' || item.line.stream === filter.stream) && (needle === '' || searchTextOf(item.line).includes(needle))))
}

/** Plain text of the lines among `items` (no escape sequences), one per line: what copying yields. */
export function plainText(items: readonly LogItem[]): string {
  return items.flatMap((item) => (item.kind === 'line' ? [stripAnsi(item.line.text)] : [])).join('\n')
}

export const gapSize = (gap: LogGap): number => gap.toSeq - gap.fromSeq + 1

/** UTF-8 size of `text` (lone surrogates count as the 3-byte replacement character). */
export function utf8Length(text: string): number {
  let length = text.length
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) continue
    if (code < 0x800) length += 1
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair (2 units) is 4 bytes.
      length += 2
      i++
    } else length += 2
  }
  return length
}

/**
 * The output view of one run (design D11). It loads the retained lines with `logs.read` and
 * appends live batches, holding batches that arrive meanwhile. Lines are identified by `seq`: a
 * line received twice (from a read and a batch) is shown once, in order (spec: user interface
 * reloaded). Holds at most `RUN_MAX_LINES` lines and `RUN_MAX_BYTES` bytes of text (UTF-8), like main
 * retains per run.
 */
export function createLogViewStore(api: Api): LogViewStore {
  const store = createStore<LogViewState>({
    commandId: null,
    runId: null,
    status: 'idle',
    error: null,
    liveError: null,
    fetchError: null,
    items: [],
    appended: 0,
    discarded: 0,
    clears: 0,
  })
  /** Working copy of the items; published as a new array by `publish`. */
  let items: LogItem[] = []
  /** Seq expected next for the shown run: lower seqs are shown or accounted for already. */
  let next = 1
  let lines = 0
  /** UTF-8 bytes of the held lines' text, compared with the per-run byte limit like main does. */
  let bytes = 0
  /** Batches of the shown run received while its retained lines are loading. */
  let held: LogBatch[] | null = null
  /** Lines in `held`; at most about `RUN_MAX_LINES` are held (older held batches are dropped). */
  let heldLines = 0
  /** Increases with every `show`, so results for an earlier run are ignored. */
  let generation = 0

  const patch = (change: Partial<LogViewState>): void => store.set({ ...store.getState(), ...change })
  const publish = (change: Partial<LogViewState> = {}): void => patch({ ...change, items: items.slice() })

  const reset = (): void => {
    items = []
    lines = 0
    bytes = 0
  }

  /** Drops the oldest items beyond the view's limits; returns how many lines were dropped. */
  const trim = (): number => {
    let excess = 0
    let dropped = 0
    while (excess < items.length && (lines - dropped > RUN_MAX_LINES || bytes > RUN_MAX_BYTES)) {
      const item = items[excess]
      excess++
      if (item?.kind === 'line') {
        dropped++
        bytes -= utf8Length(item.line.text)
      }
    }
    if (excess === 0) return 0
    items.splice(0, excess)
    lines -= dropped
    return dropped
  }

  const addGap = (fromSeq: number, toSeq: number, reason: LogGap['reason']): void => {
    if (fromSeq > toSeq) return
    const last = items.at(-1)
    if (last?.kind === 'gap' && last.reason === reason && last.toSeq + 1 === fromSeq) items[items.length - 1] = { ...last, toSeq }
    else items.push({ kind: 'gap', fromSeq, toSeq, reason })
  }

  /** Appends lines from `next` on; a missing seq becomes a gap of `reason`. Returns how many were appended. */
  const appendLines = (incoming: readonly LogLine[], reason: LogGap['reason']): number => {
    let added = 0
    for (const line of incoming) {
      if (line.seq < next) continue
      addGap(next, line.seq - 1, reason)
      items.push({ kind: 'line', line })
      lines++
      bytes += utf8Length(line.text)
      next = line.seq + 1
      added++
    }
    return added
  }

  const apply = (batch: LogBatch): number => {
    if (batch.skipped !== null && batch.skipped.toSeq >= next) {
      addGap(Math.max(batch.skipped.fromSeq, next), batch.skipped.toSeq, 'skipped')
      next = batch.skipped.toSeq + 1
    }
    return appendLines(batch.lines, 'skipped')
  }

  const read = async (runId: string, fromSeq: number): Promise<ApiResult<ReadLogsResponse>> => {
    try {
      return await api.read({ runId, fromSeq, limit: MAX_LOG_READ_LIMIT })
    } catch {
      return { ok: false, error: { code: 'internal', message: UNREACHABLE } }
    }
  }

  /** First seq the held batches cover, or `null` if none is held. */
  const heldFrom = (): number | null => {
    const first = held?.[0]
    return first === undefined ? null : (first.skipped?.fromSeq ?? first.lines[0]?.seq ?? null)
  }

  const load = async (runId: string, mine: number): Promise<void> => {
    let fromSeq = 1
    let discarded = 0
    // Main retains at most RUN_MAX_LINES lines, so this many pages read all of them; a run that
    // keeps printing is not chased further (L6-01).
    for (let pages = 0; pages < Math.ceil(RUN_MAX_LINES / MAX_LOG_READ_LIMIT) + 1; pages++) {
      const result = await read(runId, fromSeq)
      if (mine !== generation) return
      // A run is retained from its spawn on: while it is starting (or if it could not start), it
      // has no output yet. Every line it produces later arrives in a batch.
      if (!result.ok && result.error.code === 'not_found' && fromSeq === 1) break
      if (!result.ok) {
        held = null
        publish({ status: 'error', error: `Output could not be loaded: ${result.error.message}` })
        return
      }
      const page = result.value
      discarded = page.discarded
      if (fromSeq === 1) next = page.firstRetainedSeq ?? page.nextSeq
      // Lines evicted between two pages are no longer retained.
      appendLines(page.lines, 'discarded')
      if (page.lines.length < MAX_LOG_READ_LIMIT || next >= page.nextSeq) break
      // The held batches continue from here on: no need to read further.
      const from = heldFrom()
      if (from !== null && from <= next) break
      fromSeq = next
    }
    // Lines between what was read and the held batches (if any) become a fetchable `skipped` gap.
    for (const batch of held ?? []) apply(batch)
    held = null
    heldLines = 0
    const dropped = trim()
    publish({ status: 'ready', discarded: discarded + dropped })
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,

    show(commandId, runId) {
      const state = store.getState()
      if (state.commandId === commandId && state.runId === runId) return
      generation++
      reset()
      next = 1
      held = runId === null ? null : []
      heldLines = 0
      publish({ commandId, runId, status: runId === null ? 'idle' : 'loading', error: null, fetchError: null, appended: 0, discarded: 0 })
      if (runId !== null) void load(runId, generation)
    },

    receive(batch) {
      const state = store.getState()
      if (batch.runId !== state.runId || state.status === 'error') return
      if (held !== null) {
        held.push(batch)
        heldLines += batch.lines.length
        // Bounded while loading: the oldest held batches go; their lines become a fetchable gap.
        while (heldLines > RUN_MAX_LINES && held.length > 1) heldLines -= held.shift()?.lines.length ?? 0
        return
      }
      const added = apply(batch)
      const dropped = trim()
      publish({ appended: state.appended + added, discarded: state.discarded + dropped })
    },

    liveFailed(message) {
      patch({ liveError: message })
    },

    async clear() {
      const { runId } = store.getState()
      if (runId === null) return { ok: true, value: null }
      const mine = generation
      let result: ApiResult<{ clearedThroughSeq: number }>
      try {
        result = await api.clear({ runId })
      } catch {
        return { ok: false, message: UNREACHABLE }
      }
      if (!result.ok) return { ok: false, message: result.error.message }
      if (mine === generation) {
        const through = result.value.clearedThroughSeq
        // Lines captured after the clear may have arrived while it was requested: they stay
        // (L6-06). Lines up to the cleared seq still on their way are ignored through `next`.
        const kept = items.flatMap((item): LogItem[] => {
          if (item.kind === 'line') return item.line.seq > through ? [item] : []
          if (item.toSeq <= through) return []
          return [item.fromSeq > through ? item : { ...item, fromSeq: through + 1 }]
        })
        reset()
        items = kept
        for (const item of kept) {
          if (item.kind !== 'line') continue
          lines++
          bytes += utf8Length(item.line.text)
        }
        next = Math.max(next, through + 1)
        publish({ appended: 0, discarded: 0, clears: store.getState().clears + 1 })
      }
      return { ok: true, value: null }
    },

    async expand(gap) {
      const { runId } = store.getState()
      if (runId === null || gap.reason !== 'skipped') return
      const mine = generation
      const fetched: LogLine[] = []
      let fromSeq = gap.fromSeq
      while (fromSeq <= gap.toSeq) {
        const result = await read(runId, fromSeq)
        if (mine !== generation) return
        if (!result.ok) return patch({ fetchError: `Skipped lines could not be loaded: ${result.error.message}` })
        const page = result.value.lines.filter((line) => line.seq <= gap.toSeq)
        fetched.push(...page)
        const last = page.at(-1)
        if (last === undefined || page.length < result.value.lines.length || result.value.lines.length < MAX_LOG_READ_LIMIT) break
        fromSeq = last.seq + 1
      }
      const index = items.findIndex((item) => item.kind === 'gap' && item.fromSeq === gap.fromSeq && item.toSeq === gap.toSeq)
      if (index === -1) return
      // Main holds every retained line of the range, so what was not fetched is no longer retained.
      const replacement: LogItem[] = []
      let expected = gap.fromSeq
      for (const line of fetched) {
        if (line.seq < expected) continue
        if (line.seq > expected) replacement.push({ kind: 'gap', fromSeq: expected, toSeq: line.seq - 1, reason: 'discarded' })
        replacement.push({ kind: 'line', line })
        lines++
        bytes += utf8Length(line.text)
        expected = line.seq + 1
      }
      if (expected <= gap.toSeq) replacement.push({ kind: 'gap', fromSeq: expected, toSeq: gap.toSeq, reason: 'discarded' })
      items.splice(index, 1, ...replacement)
      const dropped = trim()
      publish({ fetchError: null, discarded: store.getState().discarded + dropped })
    },
  }
}

/** Subscribes the view to live batches and acknowledges each one once it has been handled. */
export function connectLogStore(store: LogViewStore, api: Pick<VeydrApi['logs'], 'onBatch' | 'ack'>): Unsubscribe {
  return api.onBatch(
    (batch) => {
      store.receive(batch)
      // A failed acknowledgement is not sent again: main starts over when a document subscribes.
      api.ack({ batchId: batch.batchId }).catch(() => undefined)
    },
    (error) => store.liveFailed(error.message),
  )
}
