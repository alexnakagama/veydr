/**
 * Limits of the log pipeline (design D11, spec process-logs). Main enforces them; the renderer
 * shows them; `docs/logs.md` documents them (checked by `test/unit/logs-docs.test.ts`). No zod
 * here: the renderer bundle imports it.
 */

/** A line longer than this many UTF-8 bytes keeps its first bytes up to the limit and is marked truncated. */
export const MAX_LINE_BYTES = 16 * 1024
/** A partial line (no newline yet) is shown once its stream has been idle this long. */
export const PARTIAL_LINE_FLUSH_MS = 100

/** Per run: at most this many lines are retained (oldest discarded first). */
export const RUN_MAX_LINES = 10_000
/** Per run: at most this many bytes of line text (UTF-8) are retained (oldest discarded first). */
export const RUN_MAX_BYTES = 8 * 1024 * 1024
/** All retained output together, across every command's current and previous run. */
export const GLOBAL_MAX_BYTES = 64 * 1024 * 1024

/** Upper bound for the lines of one `logs.read` page. */
export const MAX_LOG_READ_LIMIT = 5_000

/** A batch is sent at the latest this long after its first line was captured. */
export const BATCH_INTERVAL_MS = 50
/** A batch is sent at once when it holds this many lines. */
export const BATCH_MAX_LINES = 1_000
/** A batch is sent at once when its line text reaches this many bytes (UTF-8). */
export const BATCH_MAX_BYTES = 256 * 1024
/** With this many batches unacknowledged, live delivery holds back and then skips lines. */
export const MAX_UNACKED_BATCHES = 4

/** Secret values shorter than this are not redacted (too likely to match unrelated text). */
export const MIN_REDACTED_SECRET_LENGTH = 4
/** Replaces each occurrence of a secret value in output. */
export const REDACTION_MARKER = '[redacted]'
