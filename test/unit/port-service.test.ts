import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { PortSnapshot, ProcessIdentity } from '../../src/main/platform/types'
import { createPortService, type PortServiceDeps } from '../../src/main/ports/service'
import { portSnapshotSchema } from '../../src/shared/api'

// Tasks 8.2 and 8.3: attribution of listening ports to commands, and the read-only boundary of
// port inspection.

const API = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const WEB = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'
const id = (pid: number, starttime: number): ProcessIdentity => ({ pid, token: `boot:${starttime}` })

describe('port service', () => {
  it('[spec:port-inspection/dev-server-port-shown] attributes a port to the command whose process holds it', async () => {
    const service = createPortService({
      inspector: {
        list: () =>
          Promise.resolve({
            takenAt: 1_000,
            ports: [{ family: 'ipv4', address: '127.0.0.1', port: 5173, owner: { kind: 'known', processes: [{ identity: id(42, 7), name: 'node' }] } }],
          }),
      },
      attribution: () => Promise.resolve([{ commandId: API, processes: [id(40, 5), id(42, 7)] }]),
    })
    const snapshot = await service.list()
    expect(snapshot).toEqual({ refreshedAt: 1_000, ports: [{ family: 'ipv4', address: '127.0.0.1', port: 5173, owner: { kind: 'known', pid: 42, name: 'node', commandId: API } }] })
    expect(portSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  it('matches processes by identity: a reused PID does not make a port managed', async () => {
    const service = createPortService({
      inspector: {
        list: () =>
          Promise.resolve({ takenAt: 1, ports: [{ family: 'ipv6', address: '::', port: 8080, owner: { kind: 'known', processes: [{ identity: id(42, 900), name: 'python3' }] } }] }),
      },
      attribution: () => Promise.resolve([{ commandId: API, processes: [id(42, 7)] }]),
    })
    expect((await service.list()).ports[0]?.owner).toEqual({ kind: 'known', pid: 42, name: 'python3', commandId: null })
  })

  it('shows the holder of a shared socket that belongs to a command, else the oldest holder; passes restricted and unknown owners on', async () => {
    const inherited: PortSnapshot = {
      takenAt: 5,
      ports: [
        // The oldest holder (an unmanaged parent) passed the socket to a command's process.
        { family: 'ipv4', address: '0.0.0.0', port: 3000, owner: { kind: 'known', processes: [{ identity: id(10, 1), name: 'systemd' }, { identity: id(50, 9), name: 'node' }] } },
        { family: 'ipv4', address: '0.0.0.0', port: 3001, owner: { kind: 'known', processes: [{ identity: id(60, 2), name: 'nginx' }, { identity: id(61, 3), name: 'nginx' }] } },
        { family: 'ipv4', address: '127.0.0.1', port: 631, owner: { kind: 'restricted' } },
        { family: 'ipv6', address: '::1', port: 9000, owner: { kind: 'unknown' } },
      ],
    }
    const service = createPortService({
      inspector: { list: () => Promise.resolve(inherited) },
      attribution: () => Promise.resolve([{ commandId: WEB, processes: [id(50, 9)] }]),
    })
    expect((await service.list()).ports.map((p) => p.owner)).toEqual([
      { kind: 'known', pid: 50, name: 'node', commandId: WEB },
      { kind: 'known', pid: 60, name: 'nginx', commandId: null },
      { kind: 'restricted' },
      { kind: 'unknown' },
    ])
  })

  it('reads sockets and attribution sets at the same time, and fails when the sockets cannot be read', async () => {
    const order: string[] = []
    const service = createPortService({
      inspector: {
        list: async () => {
          order.push('sockets')
          await new Promise((done) => setTimeout(done, 5))
          order.push('sockets done')
          return { takenAt: 1, ports: [] }
        },
      },
      attribution: async () => {
        order.push('attribution')
        await Promise.resolve()
        order.push('attribution done')
        return []
      },
    })
    await service.list()
    expect(order).toEqual(['sockets', 'attribution', 'attribution done', 'sockets done'])

    const failing = createPortService({ inspector: { list: () => Promise.reject(new Error('Could not read /proc/net/tcp')) }, attribution: () => Promise.resolve([]) })
    await expect(failing.list()).rejects.toThrow('Could not read /proc/net/tcp')
  })
})

/** Every source file `entry` reaches through relative imports (type-only imports included). */
function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
      const base = resolve(dirname(file), match[1] ?? '')
      const target = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) => existsSync(candidate))
      if (target === undefined) throw new Error(`${file}: cannot resolve ${match[1]}`)
      visit(target)
    }
  }
  visit(resolve(entry))
  return [...seen]
}

describe('read-only port inspection', () => {
  const root = resolve(__dirname, '../..')
  const entries = ['src/main/ports/service.ts', 'src/main/platform/linux/ports.ts']

  it('[spec:port-inspection/no-actions-on-unrelated-processes] the ports service and the Linux inspector cannot signal, start, or connect to anything', () => {
    const forbiddenModules = /from 'node:(child_process|net|dgram|http|https|http2|tls|dns|cluster|worker_threads)'/
    // Signalling a process needs `kill` (process.kill, ChildProcess.kill) or a signal name.
    const signalling = /\bkill\s*\(|\bSIG[A-Z]{2,}\b/
    for (const entry of entries) {
      const files = importClosure(join(root, entry))
      expect(files.length, entry).toBeGreaterThan(1)
      for (const file of files) {
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
        const where = relative(root, file)
        expect(code, where).not.toMatch(forbiddenModules)
        expect(code, where).not.toMatch(signalling)
        expect(where, `${entry} reaches ${where}`).not.toMatch(/supervisor|process-tree|executable|survivors/)
      }
    }
  })

  it('the service receives nothing but the inspector and the attribution sets', () => {
    expectTypeOf<keyof PortServiceDeps>().toEqualTypeOf<'inspector' | 'attribution'>()
    expectTypeOf<keyof PortServiceDeps['inspector']>().toEqualTypeOf<'list'>()
    // The composition root hands it a function returning attribution sets, not the supervisor.
    const composition = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    expect(composition).toMatch(/createPortService\(\{ inspector: platform\.portInspector, attribution: \(\) => supervisor\.attribution\(\) \}\)/)
  })
})
