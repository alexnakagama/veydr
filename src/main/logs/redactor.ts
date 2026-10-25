import { MAX_LINE_BYTES, MIN_REDACTED_SECRET_LENGTH, REDACTION_MARKER } from '../../shared/logs/limits'
import type { CommandConfig } from '../../shared/config'
import { cutToBytes } from './splitter'

export interface RedactedLine {
  readonly text: string
  readonly truncated: boolean
}

export interface Redactor {
  /**
   * Replaces every exact occurrence of a secret value in `text` with `REDACTION_MARKER`. The
   * result never exceeds `MAX_LINE_BYTES` (a longer result is cut and marked truncated). For a
   * line the splitter truncated, a secret cut off at the end is masked too: a trailing prefix of a
   * secret of at least `MIN_REDACTED_SECRET_LENGTH` characters is replaced.
   */
  redact(text: string, truncated: boolean): RedactedLine
  /**
   * How many characters at the end of `text` are the start (at least `MIN_REDACTED_SECRET_LENGTH`
   * characters, not all of it) of a secret value; 0 if none. A partial line keeps them back, so a
   * secret printed in two parts with a pause between is still redacted as a whole (L6-04).
   */
  secretPrefixLength(text: string): number
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What to redact for a command's secret values, longest first: each value, or for a value that
 * spans several lines (e.g. a PEM key), each of its lines, since output is redacted line by line
 * (L6-02). Pieces shorter than `MIN_REDACTED_SECRET_LENGTH` are left out.
 */
export function redactableSecrets(command: Pick<CommandConfig, 'env'>): string[] {
  const values = new Set(
    command.env
      .filter((entry) => entry.secret)
      .flatMap((entry) => entry.value.split(/\r\n|\n|\r/))
      .filter((piece) => piece.length >= MIN_REDACTED_SECRET_LENGTH),
  )
  return [...values].sort((a, b) => b.length - a.length)
}

/**
 * Best-effort redaction of a run's secret values (design D11, spec: best-effort secret
 * redaction), applied before a line is retained, so a redacted value never reaches the renderer
 * or the clipboard through the logs. Values shorter than `MIN_REDACTED_SECRET_LENGTH` are not
 * redacted. Transformed (encoded, quoted, …), split, or partial values are not detected.
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  const values = [...new Set(secrets.filter((value) => value.length >= MIN_REDACTED_SECRET_LENGTH))].sort((a, b) => b.length - a.length)
  if (values.length === 0) return { redact: (text, truncated) => ({ text, truncated }), secretPrefixLength: () => 0 }
  // Longest first, so a secret that contains another is replaced as a whole.
  const pattern = new RegExp(values.map(escapeRegExp).join('|'), 'g')

  /** Length of the longest suffix of `text` that is a prefix (≥ the minimum length) of a secret. */
  const cutSecretSuffix = (text: string): number => {
    let longest = 0
    const last = text.charCodeAt(text.length - 1)
    for (const value of values) {
      for (let length = Math.min(value.length - 1, text.length); length >= MIN_REDACTED_SECRET_LENGTH && length > longest; length--) {
        // Cheap check first: the prefix must end with the text's last character.
        if (value.charCodeAt(length - 1) === last && text.endsWith(value.slice(0, length))) {
          longest = length
          break
        }
      }
    }
    return longest
  }

  return {
    secretPrefixLength: (text) => (text === '' ? 0 : cutSecretSuffix(text)),
    redact(text, truncated) {
      let out = text.replace(pattern, () => REDACTION_MARKER)
      if (truncated) {
        const cut = cutSecretSuffix(out)
        if (cut > 0) out = out.slice(0, out.length - cut) + REDACTION_MARKER
      }
      const bytes = Buffer.byteLength(out, 'utf8')
      if (bytes <= MAX_LINE_BYTES) return { text: out, truncated }
      return { text: cutToBytes(out, bytes, MAX_LINE_BYTES), truncated: true }
    },
  }
}
