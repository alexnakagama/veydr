import { useEffect, useState, type JSX } from 'react'
import type { EnvironmentPreview } from '../../shared/api'
import { Modal } from './components/Modal'
import type { ProjectActions } from './state/actions'

export interface EnvironmentDialogProps {
  readonly commandId: string
  readonly commandName: string
  readonly actions: Pick<ProjectActions, 'previewEnvironment' | 'revealSecret'>
  /** Called after a refresh read the environment, with its warnings (none: earlier warnings are obsolete). */
  readonly onRefreshed?: (warnings: readonly string[]) => void
  readonly onClose: () => void
}

type PreviewState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly preview: EnvironmentPreview } | { readonly status: 'error'; readonly message: string }

/**
 * The environment a start would use (spec: effective environment): the login environment with the
 * command's overrides. Secret values stay masked unless revealed one by one.
 */
export function EnvironmentDialog({ commandId, commandName, actions, onRefreshed, onClose }: EnvironmentDialogProps): JSX.Element {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [revealed, setRevealed] = useState<ReadonlyMap<string, string>>(new Map())
  const [revealError, setRevealError] = useState<string | null>(null)

  const load = (refresh: boolean): void => {
    setState({ status: 'loading' })
    void actions.previewEnvironment(commandId, refresh).then((result) => {
      setState(result.ok ? { status: 'ready', preview: result.value } : { status: 'error', message: result.message })
      if (result.ok && refresh) onRefreshed?.(result.value.warnings)
    })
  }
  // Loaded once when the dialog opens; Refresh asks for a new login environment.
  useEffect(() => {
    let active = true
    void actions.previewEnvironment(commandId, false).then((result) => {
      if (active) setState(result.ok ? { status: 'ready', preview: result.value } : { status: 'error', message: result.message })
    })
    return () => {
      active = false
    }
  }, [actions, commandId])

  const toggle = (key: string): void => {
    if (revealed.has(key)) {
      const next = new Map(revealed)
      next.delete(key)
      return setRevealed(next)
    }
    void actions.revealSecret(commandId, key).then((result) => {
      if (result.ok) setRevealed((current) => new Map(current).set(key, result.value))
      else setRevealError(result.message)
    })
  }

  return (
    <Modal title={`Environment of ${commandName}`} onClose={onClose} testId="environment-dialog" wide>
      <div className="modal-actions modal-actions-start">
        <button type="button" className="button" onClick={() => load(true)} disabled={state.status === 'loading'}>
          Refresh environment
        </button>
        <span className="muted">Re-reads your login shell environment for every command.</span>
      </div>
      {state.status === 'loading' && <p className="muted">Reading the environment…</p>}
      {state.status === 'error' && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      {revealError !== null && (
        <p className="form-error" role="alert">
          {revealError}
        </p>
      )}
      {state.status === 'ready' && (
        <>
          {state.preview.warnings.map((warning) => (
            <p key={warning} className="banner notice-warning" role="status" data-testid="environment-warning">
              {warning}
            </p>
          ))}
          <table className="env-table" data-testid="environment-table">
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">Value</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {state.preview.entries.map((entry) => (
                <tr key={entry.key} data-testid="environment-entry" data-key={entry.key}>
                  <th scope="row">{entry.key}</th>
                  <td>
                    {entry.secret ? (
                      <>
                        <code data-testid="environment-value">{revealed.get(entry.key) ?? '••••••••'}</code>{' '}
                        <button type="button" className="button button-small" aria-label={`${revealed.has(entry.key) ? 'Hide' : 'Reveal'} ${entry.key}`} onClick={() => toggle(entry.key)}>
                          {revealed.has(entry.key) ? 'Hide' : 'Reveal'}
                        </button>
                      </>
                    ) : (
                      <code data-testid="environment-value">{entry.value}</code>
                    )}
                  </td>
                  <td className="muted">{entry.source === 'override' ? 'Override' : 'Login environment'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
