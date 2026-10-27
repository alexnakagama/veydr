import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PORTS_POLL_INTERVAL_MS } from '../../src/renderer/src/state/ports'

// Task 8.5: docs/ports.md describes the scope, the restricted case, and the refresh behavior of the code.

const doc = readFileSync(join(__dirname, '../../docs/ports.md'), 'utf8')
const section = (title: string): string => doc.split('\n## ').find((part) => part.startsWith(`${title}\n`)) ?? ''
const view = readFileSync(join(__dirname, '../../src/renderer/src/PortsView.tsx'), 'utf8')

describe('docs/ports.md', () => {
  it('lists the restricted case, distinct from an error and from an unknown owner', () => {
    const owners = section('Owners: known, restricted, unknown')
    expect(owners).toContain('| **Restricted** | The port belongs to another user or to the system, and Linux does not show you which process holds it. |')
    expect(owners).toContain('| **Unknown** |')
    expect(owners).toContain('**Restricted** is not an error and not an absent owner')
    expect(owners).toContain('the socket was created by another user')
    expect(owners).toContain('could not be read for lack of permission')
    expect(owners).toContain("Other users' processes, which can never be read, do not count here.")
    expect(owners).toContain('When Veydr runs as root')
    // The view explains the marker in the same terms, without naming an operating system.
    expect(view).toContain('the port belongs to another user or to the system, and the operating system does not show its process to you')
    expect(view).toContain('title="Owned by another user or the system; the operating system does not show its process to you."')
    expect(view).not.toContain('Linux does not show')
  })

  it('states the scope and the refresh interval of the code', () => {
    expect(section('What is shown')).toContain('**TCP sockets in the listening state**, IPv4 and IPv6')
    expect(section('What is shown')).toContain('Not shown: UDP sockets')
    expect(section('Refreshing')).toContain(`every ${PORTS_POLL_INTERVAL_MS / 1000} seconds while the view is open and the window is visible`)
    expect(section('Read-only')).toContain('it starts no program, sends no signal, and opens no network connection')
    expect(doc).toContain('Windows')
  })

  it('names tests that exist', () => {
    for (const [, path] of doc.matchAll(/`(test\/[^`]+\.ts)`/g)) {
      expect(() => readFileSync(join(__dirname, '../..', path ?? ''), 'utf8'), path).not.toThrow()
    }
  })
})
