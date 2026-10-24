import type { JSX } from 'react'
import { Modal } from './components/Modal'

export type ShortcutCommand = 'start' | 'stop' | 'restart' | 'filter' | 'next-project' | 'previous-project' | 'help'

/** Every keyboard shortcut, in the order the help lists them. Single keys without modifiers. */
export const shortcuts: readonly { readonly key: string; readonly command: ShortcutCommand; readonly description: string }[] = [
  { key: 's', command: 'start', description: 'Start the selected command' },
  { key: 'x', command: 'stop', description: 'Stop the selected command' },
  { key: 'r', command: 'restart', description: 'Restart the selected command' },
  { key: '/', command: 'filter', description: 'Focus the project filter' },
  { key: 'j', command: 'next-project', description: 'Go to the next project' },
  { key: 'k', command: 'previous-project', description: 'Go to the previous project' },
  { key: '?', command: 'help', description: 'Show keyboard shortcuts' },
]

/** Where typing is text, not a shortcut. */
function isEditable(target: EventTarget | null): boolean {
  const element = target as { readonly tagName?: unknown; readonly isContentEditable?: unknown } | null
  if (element === null || typeof element !== 'object') return false
  if (element.isContentEditable === true) return true
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
}

/**
 * The shortcut a key press means, or `null`: never while typing in a field, never with Ctrl, Alt,
 * or Meta (those belong to the system and Chromium), and never for a repeated or composed key.
 * A command is selected by focusing or clicking its row.
 */
export function shortcutFor(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat' | 'isComposing' | 'target' | 'defaultPrevented'>): ShortcutCommand | null {
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.isComposing || isEditable(event.target)) return null
  return shortcuts.find((s) => s.key === event.key)?.command ?? null
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} testId="shortcuts-dialog">
      <dl className="shortcut-list">
        {shortcuts.map((s) => (
          <div key={s.key} className="shortcut">
            <dt>
              <kbd>{s.key}</kbd>
            </dt>
            <dd>{s.description}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">Shortcuts work outside text fields. Tab to a command (or click it) to select it.</p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
