import { win32 } from 'node:path'
import type { WindowsResolverFs } from '../../../src/main/platform/windows/resolver'

/**
 * A minimal case-insensitive fake of a Windows filesystem for the resolver: the given files, and
 * every directory above them. Paths resolve to themselves (no links or short names). The resolver's
 * own unit tests (`windows-resolver.test.ts`) use a fuller fake with links, hangs and failures.
 */
export function windowsFs(files: readonly string[]): WindowsResolverFs {
  const key = (path: string): string => win32.normalize(path).replace(/\\+$/, '').toLowerCase()
  const nodes = new Map<string, { readonly path: string; readonly directory: boolean }>()
  for (const file of files) {
    nodes.set(key(file), { path: win32.normalize(file), directory: false })
    for (let dir = win32.dirname(file); !nodes.has(key(dir)); dir = win32.dirname(dir)) {
      nodes.set(key(dir), { path: win32.normalize(dir), directory: true })
      if (win32.dirname(dir) === dir) break
    }
  }
  const find = (path: string) => {
    const node = nodes.get(key(path))
    if (node === undefined) return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }))
    return Promise.resolve(node)
  }
  return {
    lstat: (path) => find(path).then((node) => ({ isDirectory: () => node.directory, isSymbolicLink: () => false })),
    stat: (path) => find(path).then((node) => ({ isDirectory: () => node.directory })),
    realpath: (path) => find(path).then((node) => node.path),
  }
}
