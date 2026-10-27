import { Fragment, useState, type FormEvent, type JSX } from 'react'
import type { AppInfo, CommandInput, CommandView } from '../../shared/api'
import { DEFAULT_STOP_TIMEOUT_MS, envNameKey, isAbsolutePath, MAX_STOP_TIMEOUT_MS } from '../../shared/config'
import { MIN_REDACTED_SECRET_LENGTH, REDACTION_MARKER } from '../../shared/logs/limits'
import { Modal } from './components/Modal'
import type { ProjectActions } from './state/actions'

/** The platform conventions the editor follows, from `app.getInfo` (design D5). */
export type EditorConventions = Pick<AppInfo, 'defaultShell' | 'envNames'>

/** Shown wherever secret values are entered (spec: secret environment values masked; docs/configuration.md). */
export const SECRET_STORAGE_DISCLOSURE =
  'Secret values are masked here (best effort) and only shown when you reveal them, but Veydr stores them unencrypted in its configuration file, which only your user account can read.'

/** Shown with the secret disclosure (spec: best-effort secret redaction). */
export const SECRET_REDACTION_NOTE = `When the command prints a secret value exactly, its output shows ${REDACTION_MARKER} instead. This is best effort: transformed, split, or partial values are not detected, and values shorter than ${MIN_REDACTED_SECRET_LENGTH} characters are not redacted.`

/** Shown for a secret value too short to redact (spec: secret too short to redact). */
export const SHORT_SECRET_WARNING = `This value is shorter than ${MIN_REDACTED_SECRET_LENGTH} characters, so it will not be redacted from the command's output.`

/** True for a secret value that is entered (known here) but too short to be redacted. */
export const isUnredactableSecret = (secret: boolean, value: string | null): boolean => secret && value !== null && value.length > 0 && value.length < MIN_REDACTED_SECRET_LENGTH

interface EnvRow {
  /** Stable key for React; rows have no ID of their own. */
  readonly rowId: number
  readonly key: string
  readonly secret: boolean
  /** `null`: a stored secret left unchanged (its value never reached the UI). */
  readonly value: string | null
  /** The key under which the stored secret was loaded; renaming it means entering a new value. */
  readonly storedKey: string | null
  readonly revealed: boolean
}

export interface Draft {
  readonly name: string
  readonly mode: 'direct' | 'shell'
  readonly file: string
  readonly args: readonly { readonly rowId: number; readonly value: string }[]
  readonly shell: string
  readonly script: string
  readonly cwd: string
  readonly env: readonly EnvRow[]
  /** Text of the stop timeout field, in seconds. */
  readonly stopTimeout: string
}

let nextRowId = 1
const rowId = (): number => nextRowId++

/** The editor's starting state; a new shell command starts with `defaultShell`, or empty when there is none. */
export function draftFrom(command: CommandView | null, defaultShell: string | null): Draft {
  const execution = command?.execution ?? { mode: 'direct' as const, file: '', args: [] }
  return {
    name: command?.name ?? '',
    mode: execution.mode,
    file: execution.mode === 'direct' ? execution.file : '',
    args: execution.mode === 'direct' ? execution.args.map((value) => ({ rowId: rowId(), value })) : [],
    shell: execution.mode === 'shell' ? execution.shell : (defaultShell ?? ''),
    script: execution.mode === 'shell' ? execution.script : '',
    cwd: command?.cwd ?? '.',
    env: (command?.env ?? []).map((entry) => ({
      rowId: rowId(),
      key: entry.key,
      secret: entry.secret,
      value: entry.value,
      storedKey: entry.secret ? entry.key : null,
      revealed: false,
    })),
    stopTimeout: String((command?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) / 1000),
  }
}

/**
 * `draft` with `defaultShell` filled into an empty shell field. Used when the default arrives after
 * the editor opened (the app info was still loading); a shell the user entered is never replaced.
 */
export function withDefaultShell(draft: Draft, defaultShell: string | null): Draft {
  return defaultShell !== null && draft.shell === '' ? { ...draft, shell: defaultShell } : draft
}

/**
 * The request for `draft`, or a message saying what to fix. Main checks the same rules again; the
 * duplicate-variable message matches its message (spec: overrides differing only in case rejected
 * on Windows).
 */
export function inputFrom(draft: Draft, id: string | null, { defaultShell, envNames }: EditorConventions): CommandInput | string {
  if (draft.name.trim() === '') return 'Enter a name.'
  const seconds = Number(draft.stopTimeout)
  const stopTimeoutMs = Math.round(seconds * 1000)
  if (draft.stopTimeout.trim() === '' || !Number.isFinite(seconds) || stopTimeoutMs < 0 || stopTimeoutMs > MAX_STOP_TIMEOUT_MS) {
    return `The stop timeout must be between 0 and ${MAX_STOP_TIMEOUT_MS / 1000} seconds.`
  }
  if (draft.mode === 'direct' && draft.file.trim() === '') return 'Enter the executable to run.'
  if (draft.mode === 'shell' && draft.script.trim() === '') return 'Enter the script the shell runs.'
  // Surrounding spaces in the shell field are never meant (e.g. pasted text); they are dropped.
  const shell = draft.shell.trim()
  if (draft.mode === 'shell' && shell === '') return 'Enter the shell that runs the script.'
  if (draft.mode === 'shell' && !isAbsolutePath(shell)) return `The shell must be an absolute path${defaultShell === null ? '' : `, e.g. ${defaultShell}`}.`
  const keys = new Set<string>()
  for (const row of draft.env) {
    if (row.key === '' || row.key.includes('=')) return 'Every variable needs a name without "=".'
    const key = envNameKey(row.key, envNames)
    if (keys.has(key)) return `Duplicate variable "${row.key}"`
    keys.add(key)
    // A stored secret keeps its value only under its stored name, and only as a secret.
    if (row.value === null && row.key !== row.storedKey) return `Enter a value for the secret variable "${row.key}".`
    if (row.value === null && !row.secret) return `Reveal or enter the value of "${row.key}" before making it a normal variable.`
  }
  return {
    id,
    name: draft.name,
    // Arguments are passed exactly as entered: no trimming, splitting, or quoting.
    execution: draft.mode === 'direct' ? { mode: 'direct', file: draft.file, args: draft.args.map((a) => a.value) } : { mode: 'shell', shell, script: draft.script },
    cwd: draft.cwd.trim() === '' ? '.' : draft.cwd,
    env: draft.env.map((row) => ({ key: row.key, secret: row.secret, value: row.value })),
    stopTimeoutMs,
  }
}

export interface CommandEditorProps {
  readonly projectId: string
  readonly projectName: string
  /** `null` adds a new command. */
  readonly command: CommandView | null
  readonly conventions: EditorConventions
  readonly actions: Pick<ProjectActions, 'saveCommand' | 'revealSecret'>
  readonly onSaved: (command: CommandView) => void
  readonly onClose: () => void
}

/** Adds or edits a command (spec: configure commands, direct and shell mode, environment overrides). */
export function CommandEditor({ projectId, projectName, command, conventions, actions, onSaved, onClose }: CommandEditorProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(command, conventions.defaultShell))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // A default shell that arrives after opening fills an empty shell field (adjusted during render, not in an effect).
  const [appliedDefaultShell, setAppliedDefaultShell] = useState(conventions.defaultShell)
  if (appliedDefaultShell !== conventions.defaultShell) {
    setAppliedDefaultShell(conventions.defaultShell)
    setDraft((d) => withDefaultShell(d, conventions.defaultShell))
  }
  const update = (change: Partial<Draft>): void => setDraft((d) => ({ ...d, ...change }))
  const updateRow = (id: number, change: Partial<EnvRow>): void => setDraft((d) => ({ ...d, env: d.env.map((row) => (row.rowId === id ? { ...row, ...change } : row)) }))

  const reveal = (row: EnvRow): void => {
    if (row.value !== null || command === null || row.storedKey === null) {
      updateRow(row.rowId, { revealed: !row.revealed })
      return
    }
    void actions.revealSecret(command.id, row.storedKey).then((result) => {
      if (result.ok) updateRow(row.rowId, { value: result.value, revealed: true })
      else setError(result.message)
    })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const input = inputFrom(draft, command?.id ?? null, conventions)
    if (typeof input === 'string') return setError(input)
    setSaving(true)
    setError(null)
    void actions.saveCommand(projectId, input).then((result) => {
      setSaving(false)
      if (result.ok) onSaved(result.value)
      else setError(result.message)
    })
  }

  const shellLabel = draft.shell.trim() === '' ? 'Shell command — enter the shell that runs it below' : `Shell command — runs through ${draft.shell.trim()}`

  return (
    <Modal title={command === null ? `Add command to ${projectName}` : `Edit ${command.name}`} onClose={onClose} testId="command-editor" wide>
      <form className="form" onSubmit={submit} noValidate>
        {command !== null && <p className="muted">Changes take effect the next time the command starts.</p>}
        <label className="field">
          <span>Name</span>
          <input type="text" value={draft.name} onChange={(e) => update({ name: e.target.value })} required />
        </label>

        <fieldset className="field-group">
          <legend>How it runs</legend>
          <label className="choice">
            <input type="radio" name="mode" value="direct" checked={draft.mode === 'direct'} onChange={() => update({ mode: 'direct' })} />
            Executable with arguments (no shell)
          </label>
          <label className="choice">
            <input type="radio" name="mode" value="shell" checked={draft.mode === 'shell'} onChange={() => update({ mode: 'shell' })} />
            Shell script
          </label>
        </fieldset>

        {draft.mode === 'direct' ? (
          <>
            <label className="field">
              <span>Executable</span>
              <input type="text" value={draft.file} onChange={(e) => update({ file: e.target.value })} placeholder="npm, ./bin/server, /usr/bin/python3" spellCheck={false} />
            </label>
            <fieldset className="field-group">
              <legend>Arguments (each passed exactly as entered, never interpreted by a shell)</legend>
              {draft.args.map((arg, index) => (
                <div className="row" key={arg.rowId}>
                  <input
                    type="text"
                    aria-label={`Argument ${index + 1}`}
                    value={arg.value}
                    spellCheck={false}
                    onChange={(e) => update({ args: draft.args.map((a) => (a.rowId === arg.rowId ? { ...a, value: e.target.value } : a)) })}
                  />
                  <button type="button" className="button" aria-label={`Remove argument ${index + 1}`} onClick={() => update({ args: draft.args.filter((a) => a.rowId !== arg.rowId) })}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="button" onClick={() => update({ args: [...draft.args, { rowId: rowId(), value: '' }] })}>
                Add argument
              </button>
            </fieldset>
          </>
        ) : (
          <>
            <p className="shell-label" data-testid="editor-shell-label">
              {shellLabel}
            </p>
            <label className="field">
              <span>Shell</span>
              <input
                type="text"
                value={draft.shell}
                onChange={(e) => update({ shell: e.target.value })}
                placeholder={conventions.defaultShell ?? 'Absolute path of the shell'}
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Script</span>
              <textarea value={draft.script} onChange={(e) => update({ script: e.target.value })} rows={3} spellCheck={false} />
            </label>
          </>
        )}

        <label className="field">
          <span>Working directory (relative to the project folder)</span>
          <input type="text" value={draft.cwd} onChange={(e) => update({ cwd: e.target.value })} spellCheck={false} />
        </label>

        <label className="field">
          <span>Stop timeout (seconds before a stop is forced)</span>
          <input type="text" inputMode="decimal" value={draft.stopTimeout} onChange={(e) => update({ stopTimeout: e.target.value })} />
        </label>

        <fieldset className="field-group">
          <legend>Environment overrides</legend>
          <p className="muted" role="note" data-testid="secret-disclosure">
            {SECRET_STORAGE_DISCLOSURE}
          </p>
          <p className="muted" role="note" data-testid="secret-redaction-note">
            {SECRET_REDACTION_NOTE}
          </p>
          {draft.env.map((row, index) => {
            const masked = row.secret && !row.revealed
            return (
              <Fragment key={row.rowId}>
                <div className="row env-row" data-testid="env-row">
                  <input type="text" aria-label={`Variable ${index + 1} name`} value={row.key} spellCheck={false} onChange={(e) => updateRow(row.rowId, { key: e.target.value })} />
                  <input
                    type={masked ? 'password' : 'text'}
                    aria-label={`Variable ${index + 1} value`}
                    value={row.value ?? ''}
                    placeholder={row.value === null ? 'unchanged (hidden)' : ''}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => updateRow(row.rowId, { value: e.target.value })}
                  />
                  <label className="choice">
                    <input type="checkbox" checked={row.secret} onChange={(e) => updateRow(row.rowId, { secret: e.target.checked, revealed: false })} />
                    Secret
                  </label>
                  {row.secret && (
                    <button type="button" className="button" aria-label={`${row.revealed ? 'Hide' : 'Reveal'} variable ${index + 1}`} onClick={() => reveal(row)}>
                      {row.revealed ? 'Hide' : 'Reveal'}
                    </button>
                  )}
                  <button type="button" className="button" aria-label={`Remove variable ${index + 1}`} onClick={() => update({ env: draft.env.filter((r) => r.rowId !== row.rowId) })}>
                    Remove
                  </button>
                </div>
                {isUnredactableSecret(row.secret, row.value) && (
                  <p className="field-warning" role="status" data-testid="short-secret-warning">
                    {SHORT_SECRET_WARNING}
                  </p>
                )}
              </Fragment>
            )
          })}
          <button
            type="button"
            className="button"
            onClick={() => update({ env: [...draft.env, { rowId: rowId(), key: '', secret: false, value: '', storedKey: null, revealed: false }] })}
          >
            Add variable
          </button>
        </fieldset>

        {error !== null && (
          <p className="form-error" role="alert" data-testid="editor-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
