// Writes `<directory>/SHA256SUMS` for the named files, in GNU sha256sum's text-mode format
// (`<hex>  <name>`, LF line ends), then verifies what it wrote (add-windows-packaging design D6).
//
//   node scripts/sha256sums.mjs <directory> <file>...
//
// It exists because the `sha256sum` of Git for Windows marks every file as binary (`<hex> *<name>`),
// so the Windows jobs of build.yml cannot produce the format users check with `sha256sum -c` and the
// release compares against. It runs the same on every system.
//
// Each <file> is a plain file name inside <directory>, never a path. A refused name (one with a
// path separator, one ending in ".", a name repeated in any case, SHA256SUMS itself in any case) or
// no name at all exits 1 and changes nothing on disk. A missing or non-regular file, or a failure
// while writing or verifying, exits 1 and leaves no SHA256SUMS behind, an earlier one included.
// The file is written beside the packages under a temporary name and renamed into place, so a
// reader never sees a partial file.
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const SUMS_FILE = 'SHA256SUMS'

/**
 * Names `sha256sum` writes and reads back unescaped, and that mean the same file on Windows and
 * Linux: letters, digits, `.`, `_`, `+` and `-`, not starting with `.` or `-`. A backslash or a line
 * break would make GNU sha256sum escape the line; `:` names an alternate data stream on Windows.
 */
const SAFE_NAME = /^[A-Za-z0-9_+][A-Za-z0-9._+-]*$/
const LINE = /^([0-9a-f]{64}) {2}([^\r\n]+)$/

/** Why `name` cannot be listed in SHA256SUMS, or undefined when it can. */
export function nameProblem(name) {
  if (typeof name !== 'string' || name === '') return 'an empty file name'
  if (/[/\\]/.test(name)) return `${JSON.stringify(name)} has a path separator: name a file inside the directory`
  if (!SAFE_NAME.test(name)) return `${JSON.stringify(name)} is not a plain file name (letters, digits, ".", "_", "+" and "-", not starting with "." or "-")`
  // Windows drops a trailing dot, so `SHA256SUMS.` or `a.exe.` would name another file there.
  if (name.endsWith('.')) return `${JSON.stringify(name)} ends with ".", which Windows drops, so it would name another file`
  // Case-insensitively: on Windows `sha256sums` is the same file, which writeSums removes first.
  if (name.toUpperCase() === SUMS_FILE) return `${SUMS_FILE} cannot list itself`
  return undefined
}

/** The SHA-256 of `file` as lower-case hex, read as a stream (an installer is about 100 MB). */
export async function sha256File(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** One SHA256SUMS line, LF-terminated. */
export function formatLine(hex, name) {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a SHA-256 digest: ${JSON.stringify(hex)}`)
  const problem = nameProblem(name)
  if (problem !== undefined) throw new Error(problem)
  return `${hex}  ${name}\n`
}

/** The `[hex, name]` pairs of a SHA256SUMS text; throws on anything that is not exactly that format. */
export function parseSums(text) {
  if (!text.endsWith('\n') || text.includes('\r')) throw new Error(`${SUMS_FILE} must end every line with LF only`)
  return text
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      const match = LINE.exec(line)
      const problem = match === null ? 'not "<sha256>  <name>"' : nameProblem(match[2])
      if (problem !== undefined) throw new Error(`${SUMS_FILE} line ${index + 1}: ${problem}`)
      return [match[1], match[2]]
    })
}

/** Throws unless there is at least one name, and every name can be listed and is unique. Touches nothing on disk. */
function checkNameList(names) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('no file to checksum')
  const seen = new Set()
  for (const name of names) {
    const problem = nameProblem(name)
    if (problem !== undefined) throw new Error(problem)
    // Case-insensitively: on Windows `A.exe` and `a.exe` are the same file.
    if (seen.has(name.toUpperCase())) throw new Error(`${JSON.stringify(name)} is named twice`)
    seen.add(name.toUpperCase())
  }
}

/**
 * Throws unless every name is a regular file (not a link) in `directory`. The files are opened by
 * name afterwards, so a link swapped in between would be followed; the directory is the job's own
 * `dist/`, which nothing else writes to while the script runs.
 */
function checkFiles(directory, names) {
  for (const name of names) {
    let stat
    try {
      stat = lstatSync(join(directory, name))
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${name} does not exist in ${directory}`)
      throw error
    }
    if (!stat.isFile()) throw new Error(`${name} in ${directory} is not a regular file`)
  }
}

/**
 * Writes `<directory>/SHA256SUMS` for `names`, in the given order, and verifies it by reading it
 * back and hashing every file again. Returns the text written. A refused name changes nothing; any
 * later failure leaves no SHA256SUMS.
 */
export async function writeSums(directory, names) {
  if (!lstatSync(directory).isDirectory()) throw new Error(`${directory} is not a directory`)
  const target = join(directory, SUMS_FILE)
  const partial = join(directory, `.${SUMS_FILE}.${process.pid}.partial`)
  // The names are checked before anything is removed: on Windows a refused name such as
  // `sha256sums` is the same file as the target, and must survive its refusal.
  checkNameList(names)
  // A SHA256SUMS from an earlier run must not survive a failed run and be uploaded.
  rmSync(target, { force: true })
  checkFiles(directory, names)
  try {
    const lines = []
    for (const name of names) lines.push(formatLine(await sha256File(join(directory, name)), name))
    const text = lines.join('')
    writeFileSync(partial, text, { flag: 'wx' })
    renameSync(partial, target)
    await verifySums(directory, names, text)
    return text
  } catch (error) {
    rmSync(partial, { force: true })
    rmSync(target, { force: true })
    throw error
  }
}

/** Throws unless `<directory>/SHA256SUMS` is exactly `expected`, lists `names` in order, and matches every file. */
export async function verifySums(directory, names, expected) {
  const text = readFileSync(join(directory, SUMS_FILE), 'utf8')
  if (text !== expected) throw new Error(`${SUMS_FILE} does not hold what was written`)
  const pairs = parseSums(text)
  const listed = pairs.map(([, name]) => name)
  if (listed.join('\n') !== names.join('\n')) throw new Error(`${SUMS_FILE} lists ${listed.join(', ')}, expected ${names.join(', ')}`)
  for (const [hex, name] of pairs) {
    const actual = await sha256File(join(directory, name))
    if (actual !== hex) throw new Error(`${name} changed while it was checksummed: ${SUMS_FILE} has ${hex}, the file is now ${actual}`)
  }
}

export async function main(args) {
  const [directory, ...names] = args
  if (directory === undefined || directory === '' || names.length === 0) {
    console.error('usage: sha256sums.mjs <directory> <file>...')
    return 1
  }
  try {
    const text = await writeSums(directory, names)
    process.stdout.write(text)
    console.log(`sha256sums: wrote and verified ${join(directory, SUMS_FILE)} for ${names.length} file${names.length === 1 ? '' : 's'}`)
    return 0
  } catch (error) {
    console.error(`sha256sums: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/** True when Node runs this file as the entry point. Node resolves symlinks for `import.meta.url`, so argv[1] is too. */
function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntryPoint()) process.exitCode = await main(process.argv.slice(2))
