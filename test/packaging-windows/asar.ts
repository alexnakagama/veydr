import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Reads and rewrites ASAR archives (https://github.com/electron/asar#format) for the Windows
// packaging tests (add-windows-packaging design D3). The Linux tests keep their own reader, so they
// stay unchanged.
//
// Layout: a pickle holding the header's size, then a pickle holding the header JSON (length-prefixed
// and padded to 4 bytes), then the file contents at the offsets the header names.

export interface AsarIntegrity {
  readonly algorithm: 'SHA256'
  readonly hash: string
  readonly blockSize: number
  readonly blocks: readonly string[]
}

export interface AsarEntry {
  readonly files?: Record<string, AsarEntry>
  readonly size?: number
  readonly offset?: string
  readonly unpacked?: boolean
  readonly executable?: boolean
  readonly link?: string
  readonly integrity?: AsarIntegrity
}

export interface Asar {
  /** Every file below the root as `/dir/name`, sorted. */
  readonly files: string[]
  readonly header: AsarEntry
  /** The header JSON exactly as stored, which Electron hashes for its integrity check. */
  readonly headerJson: string
  read(file: string): Buffer
}

/** electron/asar's integrity block size (4 MiB). */
const BLOCK_SIZE = 4 * 1024 * 1024

export function parseAsar(bytes: Buffer): Asar {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw new Error('not an ASAR archive')
  const headerSize = bytes.readUInt32LE(4)
  const jsonSize = bytes.readUInt32LE(12)
  if (16 + jsonSize > 8 + headerSize || 8 + headerSize > bytes.length) throw new Error('truncated ASAR header')
  const headerJson = bytes.subarray(16, 16 + jsonSize).toString('utf8')
  const header = JSON.parse(headerJson) as AsarEntry
  const base = 8 + headerSize
  const entries = new Map<string, AsarEntry>()
  const walk = (entry: AsarEntry, prefix: string): void => {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const path = `${prefix}/${name}`
      if (child.files === undefined) entries.set(path, child)
      else walk(child, path)
    }
  }
  walk(header, '')
  return {
    files: [...entries.keys()].sort(),
    header,
    headerJson,
    read(file) {
      const entry = entries.get(file)
      if (entry?.offset === undefined || entry.size === undefined) throw new Error(`${file} is not in the archive`)
      const start = base + Number(entry.offset)
      if (start + entry.size > bytes.length) throw new Error(`${file} lies outside the archive`)
      return bytes.subarray(start, start + entry.size)
    },
  }
}

export const readAsar = (path: string): Asar => parseAsar(readFileSync(path))

/** electron/asar's per-file integrity: the SHA-256 of the file and of each 4 MiB block. */
export function integrityOf(data: Buffer): AsarIntegrity {
  const blocks: string[] = []
  for (let at = 0; at < data.length || (at === 0 && blocks.length === 0); at += BLOCK_SIZE) {
    blocks.push(createHash('sha256').update(data.subarray(at, at + BLOCK_SIZE)).digest('hex'))
  }
  return { algorithm: 'SHA256', hash: createHash('sha256').update(data).digest('hex'), blockSize: BLOCK_SIZE, blocks }
}

/**
 * A new archive with the same files as `archive`, except `file`, whose contents are `data`. Offsets,
 * the size and the file's integrity entry are rewritten, so the header is self-consistent: only the
 * hash of the header, which Electron compares with the one embedded in the application binary, differs.
 */
export function replaceFile(archive: Asar, file: string, data: Buffer): Buffer {
  if (!archive.files.includes(file)) throw new Error(`${file} is not in the archive`)
  const contents: Buffer[] = []
  let offset = 0
  const rebuild = (entry: AsarEntry, prefix: string): AsarEntry => {
    if (entry.files !== undefined) {
      const files: Record<string, AsarEntry> = {}
      for (const [name, child] of Object.entries(entry.files)) files[name] = rebuild(child, `${prefix}/${name}`)
      return { ...entry, files }
    }
    if (entry.unpacked === true || entry.link !== undefined || entry.offset === undefined) return entry
    const body = prefix === file ? data : archive.read(prefix)
    const rebuilt: AsarEntry = { ...entry, size: body.length, offset: String(offset), ...(prefix === file ? { integrity: integrityOf(body) } : {}) }
    contents.push(body)
    offset += body.length
    return rebuilt
  }
  const header = Buffer.from(JSON.stringify(rebuild(archive.header, '')), 'utf8')
  const padded = header.length + ((4 - (header.length % 4)) % 4)
  const prefix = Buffer.alloc(16 + padded)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(8 + padded, 4)
  prefix.writeUInt32LE(4 + padded, 8)
  prefix.writeUInt32LE(header.length, 12)
  header.copy(prefix, 16)
  return Buffer.concat([prefix, ...contents])
}

/** `archive` (its bytes) with `file`'s contents overwritten in place by `data` of the same length; the header is untouched. */
export function overwriteInPlace(bytes: Buffer, file: string, data: Buffer): Buffer {
  const archive = parseAsar(bytes)
  const original = archive.read(file)
  if (data.length !== original.length) throw new Error(`replacement is ${data.length} bytes, ${file} is ${original.length}`)
  const out = Buffer.from(bytes)
  const at = original.byteOffset - bytes.byteOffset
  data.copy(out, at)
  return out
}
