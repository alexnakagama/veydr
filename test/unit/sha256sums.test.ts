import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatLine, nameProblem, parseSums, writeSums } from '../../scripts/sha256sums.mjs'

// scripts/sha256sums.mjs (add-windows-packaging design D6, task 5.1): writes SHA256SUMS in GNU
// sha256sum's text-mode format on every system, so build.yml's Windows job and the release produce
// the same file users check with `sha256sum -c`. These tests run on Linux and in the windows CI job.

const root = resolve(__dirname, '../..')
const script = join(root, 'scripts/sha256sums.mjs')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A temporary directory holding `files` (name → contents). */
function folder(files: Record<string, string | Buffer> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-sums-'))
  dirs.push(dir)
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
  return dir
}

const digest = (contents: string | Buffer): string => createHash('sha256').update(contents).digest('hex')

/** Runs the script as the workflows do. */
const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

const installer = 'Veydr-1.2.3-rc.1-x64-setup.exe'
// Bytes that a text-mode reader would change: CRLF, a lone CR, NUL, and a byte that is not UTF-8.
const binary = Buffer.from([0x4d, 0x5a, 0x0d, 0x0a, 0x00, 0x0d, 0xff, 0x0a, 0x1a])

describe('sha256sums.mjs', () => {
  it('writes one "<hex>  <name>" line per file, in the given order, with LF line ends, and verifies it', () => {
    const files = { [installer]: binary, 'Veydr-1.2.3-amd64.deb': 'deb\r\n', 'a.AppImage': '' }
    const dir = folder(files)
    const run = cli(dir, installer, 'Veydr-1.2.3-amd64.deb', 'a.AppImage')
    expect(run.status, run.stderr).toBe(0)
    const expected = `${digest(binary)}  ${installer}\n${digest('deb\r\n')}  Veydr-1.2.3-amd64.deb\n${digest('')}  a.AppImage\n`
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe(expected)
    expect(readFileSync(join(dir, 'SHA256SUMS')).includes(0x0d)).toBe(false)
    expect(run.stdout).toBe(`${expected}sha256sums: wrote and verified ${join(dir, 'SHA256SUMS')} for 3 files\n`)
    // Nothing else is left beside the packages.
    expect(readdirSync(dir).sort()).toEqual(['SHA256SUMS', 'Veydr-1.2.3-amd64.deb', installer, 'a.AppImage'].sort())
  })

  it('hashes a file larger than one read buffer as a whole', () => {
    const large = Buffer.alloc(5 * 1024 * 1024 + 17, 0x5a)
    const dir = folder({ [installer]: large })
    expect(cli(dir, installer).status).toBe(0)
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe(`${digest(large)}  ${installer}\n`)
  })

  it('replaces an earlier SHA256SUMS instead of appending to it', () => {
    const dir = folder({ [installer]: 'new\n', SHA256SUMS: `${digest('old\n')}  old.exe\n` })
    expect(cli(dir, installer).status).toBe(0)
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe(`${digest('new\n')}  ${installer}\n`)
  })

  it.each([
    ['no file', [], 'usage: sha256sums.mjs <directory> <file>...'],
    ['a missing file', ['Veydr-1.2.3-x64-setup.exe'], 'Veydr-1.2.3-x64-setup.exe does not exist in'],
    ['a name with a slash', [`sub/${installer}`], 'has a path separator'],
    ['a name with a backslash', [`sub\\${installer}`], 'has a path separator'],
    ['a relative path out of the directory', [`../${installer}`], 'has a path separator'],
    ['a name naming the directory itself', ['.'], 'is not a plain file name'],
    ['the parent directory', ['..'], 'is not a plain file name'],
    ['a name with a line break', ['a\nb.exe'], 'is not a plain file name'],
    ['a name with a colon (a Windows alternate data stream)', [`${installer}:stream`], 'is not a plain file name'],
    ['a name with a space', ['Veydr setup.exe'], 'is not a plain file name'],
    ['a name starting with "-"', ['-c'], 'is not a plain file name'],
    ['an empty name', [''], 'an empty file name'],
    ['SHA256SUMS itself', ['SHA256SUMS'], 'SHA256SUMS cannot list itself'],
    ['SHA256SUMS in another case (the same file on Windows)', ['sha256sums'], 'SHA256SUMS cannot list itself'],
    ['a name given twice', [installer, installer], 'is named twice'],
    ['a valid name next to a missing one', [installer, 'missing.exe'], 'missing.exe does not exist in'],
  ])('exits 1 for %s, and leaves no SHA256SUMS', (_case, names, message) => {
    const dir = folder({ [installer]: 'x', SHA256SUMS: 'stale\n' })
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', installer), 'x')
    const run = cli(dir, ...names)
    expect(run.status, run.stdout).toBe(1)
    expect(run.stderr).toContain(message)
    // A refused name is refused before anything is removed; a file found missing or not regular
    // afterwards removes the stale SHA256SUMS, so it cannot be uploaded.
    const sums = existsSync(join(dir, 'SHA256SUMS')) ? readFileSync(join(dir, 'SHA256SUMS'), 'utf8') : undefined
    expect(sums).toBe(message.includes('does not exist') ? undefined : 'stale\n')
    expect(readdirSync(dir).filter((name) => name.includes('partial'))).toEqual([])
  })

  // On Windows `sha256sums` is the target itself. On every system, the untouched stale SHA256SUMS
  // shows that the refusal came before the removal, so the case-variant file would survive too.
  it('refuses a name that is SHA256SUMS in another case before removing anything', async () => {
    const dir = folder({ [installer]: 'x', sha256sums: 'mine\n', SHA256SUMS: 'stale\n' })
    const run = cli(dir, installer, 'sha256sums')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('SHA256SUMS cannot list itself')
    await expect(writeSums(dir, ['sha256sums'])).rejects.toThrow('SHA256SUMS cannot list itself')
    expect(existsSync(join(dir, 'sha256sums'))).toBe(true)
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe('stale\n')
  })

  it('exits 1 for a directory, a missing directory, or no directory', () => {
    const dir = folder({ [installer]: 'x' })
    mkdirSync(join(dir, 'Veydr.exe'))
    expect(cli(dir, 'Veydr.exe').stderr).toContain('Veydr.exe in')
    expect(cli(dir, 'Veydr.exe').status).toBe(1)
    const missing = cli(join(dir, 'nowhere'), installer)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('sha256sums: ')
    expect(cli().status).toBe(1)
    expect(cli('', installer).status).toBe(1)
  })

  // Creating a symbolic link needs a privilege that the Windows runner's account has, but a developer's may not.
  it.skipIf(process.platform !== 'linux')('[linux-only: unprivileged symbolic links] refuses a symbolic link, so a file outside the directory is never listed', () => {
    const outside = folder({ 'secret.txt': 'secret' })
    const dir = folder()
    symlinkSync(join(outside, 'secret.txt'), join(dir, installer))
    const run = cli(dir, installer)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('is not a regular file')
  })

  it('formats and parses only the exact format', () => {
    const hex = digest('x')
    expect(formatLine(hex, installer)).toBe(`${hex}  ${installer}\n`)
    expect(() => formatLine(hex.toUpperCase(), installer)).toThrow('not a SHA-256 digest')
    expect(() => formatLine(hex.slice(1), installer)).toThrow('not a SHA-256 digest')
    expect(() => formatLine(hex, 'a/b')).toThrow('path separator')
    expect(parseSums(`${hex}  a.exe\n${hex}  b.deb\n`)).toEqual([
      [hex, 'a.exe'],
      [hex, 'b.deb'],
    ])
    for (const text of [`${hex}  a.exe`, `${hex}  a.exe\r\n`, `${hex} *a.exe\n`, `${hex} a.exe\n`, `${hex}  a/b\n`, `${hex}  a.exe\n\n`, '']) {
      expect(() => parseSums(text), JSON.stringify(text)).toThrow()
    }
    expect(nameProblem(installer)).toBeUndefined()
    expect(nameProblem('Veydr-0.1.0-rc.1-x86_64.AppImage')).toBeUndefined()
  })

  it('checksums from the module the same way as from the command line', async () => {
    const dir = folder({ [installer]: binary })
    await expect(writeSums(dir, [installer])).resolves.toBe(`${digest(binary)}  ${installer}\n`)
    await expect(writeSums(dir, [])).rejects.toThrow('no file to checksum')
  })

  // GNU coreutils is on the ubuntu runner; the windows runner's sha256sum is Git for Windows', which
  // writes binary-mode lines, the reason this script exists.
  it.skipIf(process.platform !== 'linux')('[linux-only: GNU sha256sum] writes exactly what sha256sum writes for the same files, and sha256sum -c accepts it', () => {
    const names = [installer, 'Veydr-1.2.3-rc.1-amd64.deb', 'Veydr-1.2.3-rc.1-x86_64.AppImage']
    const dir = folder({ [names[0] as string]: binary, [names[1] as string]: 'deb\n', [names[2] as string]: Buffer.alloc(70_000, 1) })
    const gnu = spawnSync('sha256sum', ['--', ...names], { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    expect(gnu.status, gnu.stderr).toBe(0)
    expect(cli(dir, ...names).status).toBe(0)
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe(gnu.stdout)
    const check = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout).toBe(names.map((n) => `${n}: OK\n`).join(''))
  })
})
