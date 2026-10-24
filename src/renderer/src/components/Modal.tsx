import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react'

export interface ModalProps {
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
  /** `alertdialog` for confirmations of destructive actions. */
  readonly role?: 'dialog' | 'alertdialog'
  readonly testId?: string
  readonly wide?: boolean
}

/**
 * A modal dialog (`<dialog>` shown with `showModal`): the rest of the window is inert while it is
 * open, focus starts on its first focusable element, Escape closes it, and focus returns where it
 * was on close.
 */
export function Modal({ title, onClose, children, role = 'dialog', testId, wide = false }: ModalProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return undefined
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    // Escape: the dialog's `cancel` event; the parent decides by unmounting it.
    const cancel = (event: Event): void => {
      event.preventDefault()
      closeRef.current()
    }
    dialog.addEventListener('cancel', cancel)
    return () => {
      dialog.removeEventListener('cancel', cancel)
      if (dialog.open) dialog.close()
      if (returnTo?.isConnected === true) returnTo.focus()
    }
  }, [])

  return (
    <dialog ref={ref} className={`modal${wide ? ' modal-wide' : ''}`} role={role} aria-labelledby={titleId} data-testid={testId}>
      <h2 id={titleId} className="modal-title">
        {title}
      </h2>
      {children}
    </dialog>
  )
}

export interface ConfirmDialogProps {
  readonly title: string
  readonly message: ReactNode
  readonly confirmLabel: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
  /** Shown while the confirmed action runs; the buttons are disabled meanwhile. */
  readonly pending?: boolean
  readonly error?: string | null
}

/** Asks before a destructive action; Cancel has focus first, so Enter alone does not confirm. */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel, pending = false, error = null }: ConfirmDialogProps): JSX.Element {
  return (
    <Modal title={title} onClose={onCancel} role="alertdialog" testId="confirm-dialog">
      <div className="modal-body">{message}</div>
      {error !== null && (
        <p className="form-error" role="alert" data-testid="confirm-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-danger" disabled={pending} onClick={onConfirm}>
          {pending ? `${confirmLabel}…` : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
