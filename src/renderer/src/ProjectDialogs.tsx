import { useState, type FormEvent, type JSX } from 'react'
import type { ProjectView } from '../../shared/api'
import { Modal } from './components/Modal'
import type { Outcome, ProjectActions } from './state/actions'

/** The folder's own name, suggested as the project name. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts.at(-1) ?? path
}

interface NameDialogProps {
  readonly title: string
  readonly initialName: string
  readonly submitLabel: string
  readonly submit: (name: string) => Promise<Outcome<ProjectView>>
  readonly onDone: (project: ProjectView) => void
  readonly onClose: () => void
  readonly children?: JSX.Element
}

function NameDialog({ title, initialName, submitLabel, submit, onDone, onClose, children }: NameDialogProps): JSX.Element {
  const [name, setName] = useState(initialName)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (name.trim() === '') return setError('Enter a name.')
    setPending(true)
    setError(null)
    void submit(name).then((result) => {
      setPending(false)
      if (result.ok) onDone(result.value)
      else setError(result.message)
    })
  }
  return (
    <Modal title={title} onClose={onClose} testId="project-dialog">
      <form className="form" onSubmit={onSubmit} noValidate>
        <label className="field">
          <span>Project name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {children}
        {error !== null && (
          <p className="form-error" role="alert" data-testid="project-dialog-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={pending}>
            {pending ? `${submitLabel}…` : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export interface AddProjectDialogProps {
  /** The folder chosen in the native picker. */
  readonly path: string
  readonly actions: Pick<ProjectActions, 'addProject'>
  readonly onAdded: (project: ProjectView) => void
  readonly onClose: () => void
}

/** Confirms the name of a project for a picked folder (spec: register a project folder). */
export function AddProjectDialog({ path, actions, onAdded, onClose }: AddProjectDialogProps): JSX.Element {
  return (
    <NameDialog title="Add project" initialName={folderName(path)} submitLabel="Add project" submit={(name) => actions.addProject(path, name)} onDone={onAdded} onClose={onClose}>
      <p className="field">
        <span>Folder</span>
        <code data-testid="project-dialog-path">{path}</code>
      </p>
    </NameDialog>
  )
}

export interface RenameProjectDialogProps {
  readonly project: ProjectView
  readonly actions: Pick<ProjectActions, 'renameProject'>
  readonly onClose: () => void
}

export function RenameProjectDialog({ project, actions, onClose }: RenameProjectDialogProps): JSX.Element {
  return (
    <NameDialog
      title={`Rename ${project.name}`}
      initialName={project.name}
      submitLabel="Rename"
      submit={(name) => actions.renameProject(project.id, name)}
      onDone={onClose}
      onClose={onClose}
    />
  )
}
