import { useEffect, useState, type FormEvent, type JSX } from 'react'
import { EDITOR_PATH_PLACEHOLDER, type Settings } from '../../shared/config'
import type { ProjectActions } from './state/actions'

interface EditorDraft {
  readonly file: string
  readonly args: readonly { readonly rowId: number; readonly value: string }[]
}

let nextRowId = 1

const draftOf = (settings: Settings): EditorDraft => ({
  file: settings.editor?.file ?? '',
  args: (settings.editor?.args ?? [EDITOR_PATH_PLACEHOLDER]).map((value) => ({ rowId: nextRowId++, value })),
})

type Status = { readonly kind: 'idle' } | { readonly kind: 'saved' } | { readonly kind: 'error'; readonly message: string }

/** The editor Veydr opens projects in (spec: open in configured editor). */
export function SettingsView({ actions }: { actions: Pick<ProjectActions, 'getSettings' | 'setEditor'> }): JSX.Element {
  const [draft, setDraft] = useState<EditorDraft | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    let active = true
    void actions.getSettings().then((result) => {
      if (!active) return
      if (result.ok) setDraft(draftOf(result.value))
      else setStatus({ kind: 'error', message: result.message })
    })
    return () => {
      active = false
    }
  }, [actions])

  const save = (editor: { file: string; args: string[] } | null): void => {
    setStatus({ kind: 'idle' })
    void actions.setEditor(editor).then((result) => {
      if (!result.ok) return setStatus({ kind: 'error', message: result.message })
      setDraft(draftOf(result.value))
      setStatus({ kind: 'saved' })
    })
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (draft === null) return
    if (draft.file.trim() === '') return setStatus({ kind: 'error', message: 'Enter the editor executable.' })
    const args = draft.args.map((a) => a.value)
    if (!args.some((arg) => arg.includes(EDITOR_PATH_PLACEHOLDER))) return setStatus({ kind: 'error', message: `One argument must contain ${EDITOR_PATH_PLACEHOLDER}.` })
    save({ file: draft.file, args })
  }

  return (
    <>
      <h1 id="view-title">Settings</h1>
      <section className="settings-section" aria-labelledby="settings-editor">
        <h2 id="settings-editor">Editor</h2>
        <p className="muted">
          Veydr starts the editor directly (no shell) with these arguments; {EDITOR_PATH_PLACEHOLDER} is replaced by the project folder as a single argument. Veydr does not watch or stop the editor.
        </p>
        {draft === null ? (
          status.kind !== 'error' && <p className="muted">Loading…</p>
        ) : (
          <form className="form" onSubmit={onSubmit} noValidate>
            <label className="field">
              <span>Editor executable</span>
              <input type="text" value={draft.file} placeholder="code" spellCheck={false} onChange={(e) => setDraft({ ...draft, file: e.target.value })} />
            </label>
            <fieldset className="field-group">
              <legend>Arguments</legend>
              {draft.args.map((arg, index) => (
                <div className="row" key={arg.rowId}>
                  <input
                    type="text"
                    aria-label={`Editor argument ${index + 1}`}
                    value={arg.value}
                    spellCheck={false}
                    onChange={(e) => setDraft({ ...draft, args: draft.args.map((a) => (a.rowId === arg.rowId ? { ...a, value: e.target.value } : a)) })}
                  />
                  <button type="button" className="button" aria-label={`Remove editor argument ${index + 1}`} onClick={() => setDraft({ ...draft, args: draft.args.filter((a) => a.rowId !== arg.rowId) })}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="button" onClick={() => setDraft({ ...draft, args: [...draft.args, { rowId: nextRowId++, value: '' }] })}>
                Add argument
              </button>
            </fieldset>
            <div className="modal-actions modal-actions-start">
              <button type="submit" className="button button-primary">
                Save editor
              </button>
              <button type="button" className="button" onClick={() => save(null)}>
                Remove editor
              </button>
            </div>
          </form>
        )}
        {status.kind === 'saved' && (
          <p className="muted" role="status">
            Saved.
          </p>
        )}
        {status.kind === 'error' && (
          <p className="form-error" role="alert">
            {status.message}
          </p>
        )}
      </section>
    </>
  )
}
