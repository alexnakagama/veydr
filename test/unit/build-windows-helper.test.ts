import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BuildError,
  HASH_PATH,
  HELPER_PATH,
  NOT_WINDOWS_MESSAGE,
  OUTPUT_DIR,
  SOURCE_PATH,
  buildHelper,
  compilerArguments,
  compilerPath,
  isUpToDate,
  runBuildCli,
  sourceHash,
  type BuildOptions,
  type CompilerResult,
} from '../../scripts/build-windows-helper.mjs'

// The build script of the Windows helper (add-windows-process-supervision design D5). The compiler
// is replaced by a fake, so these tests run on every system; the real build is the `windows` CI job.

const root = resolve(__dirname, '../..')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Run = NonNullable<BuildOptions['run']>
type Options = Required<BuildOptions>

interface Fixture {
  options: Options
  calls: { compiler: string; args: readonly string[] }[]
  /** The directory holding the binary, the hash and the partial file. */
  outDir: string
  /** A compiler that fails with `result` instead of succeeding. */
  failing: (result: CompilerResult) => Options
}

/** A build directory with a source, a compiler that exists, and a fake `run` that writes the output it is told to. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'veydr-helper-build-'))
  dirs.push(dir)
  const source = join(dir, 'veydr-helper.cs')
  writeFileSync(source, 'class A {}')
  writeFileSync(join(dir, 'csc.exe'), '')
  const calls: Fixture['calls'] = []
  const run: Run = (compiler, args) => {
    calls.push({ compiler, args })
    const out = args.find((a) => a.startsWith('/out:'))?.slice('/out:'.length)
    if (out !== undefined) writeFileSync(out, 'MZ')
    return { status: 0, output: '' }
  }
  const outDir = join(dir, 'out')
  const options: Options = {
    platform: 'win32',
    compiler: join(dir, 'csc.exe'),
    source,
    binary: join(outDir, 'veydr-helper.exe'),
    hashFile: join(outDir, 'veydr-helper.sha256'),
    partial: join(outDir, 'veydr-helper.partial.exe'),
    run,
  }
  return { options, calls, outDir, failing: (result) => ({ ...options, run: () => result }) }
}

const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

describe('build-windows-helper paths and compiler', () => {
  it('builds the committed source into the git-ignored out-helper directory', () => {
    expect(relative(root, SOURCE_PATH).split('\\').join('/')).toBe('src/main/platform/windows/helper/veydr-helper.cs')
    expect(existsSync(SOURCE_PATH)).toBe(true)
    expect(relative(root, OUTPUT_DIR)).toBe('out-helper')
    expect(relative(root, HELPER_PATH).split('\\').join('/')).toBe('out-helper/veydr-helper.exe')
    expect(relative(OUTPUT_DIR, HASH_PATH)).toBe('veydr-helper.sha256')
    expect(readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/)).toContain('out-helper/')
  })

  it('uses the 64-bit .NET Framework 4 compiler of the Windows directory', () => {
    expect(compilerPath('C:\\Windows')).toBe(join('C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'))
  })

  it('compiles an executable with optimization and warnings as errors', () => {
    expect(compilerArguments('in.cs', 'out.exe')).toEqual(['/nologo', '/optimize+', '/warnaserror+', '/target:exe', '/out:out.exe', 'in.cs'])
  })

  it('hashes the source with SHA-256', () => {
    const { options } = fixture()
    expect(sourceHash(options.source)).toBe(createHash('sha256').update('class A {}').digest('hex'))
    expect(sourceHash()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('up-to-date check', () => {
  it('is true only when the binary exists and the stored hash matches', () => {
    const { options } = fixture()
    const hash = sourceHash(options.source)
    const input = { binary: options.binary, hashFile: options.hashFile, hash }
    expect(isUpToDate(input)).toBe(false)
    buildHelper(options)
    expect(isUpToDate(input)).toBe(true)
    expect(isUpToDate({ ...input, hash: 'a'.repeat(64) })).toBe(false)
    rmSync(options.binary)
    expect(isUpToDate(input)).toBe(false)
  })

  it('ignores the line ending of the stored hash', () => {
    const { options } = fixture()
    buildHelper(options)
    const hash = sourceHash(options.source)
    for (const text of [hash, `${hash}\n`, `${hash}\r\n`]) {
      writeFileSync(options.hashFile, text)
      expect(isUpToDate({ binary: options.binary, hashFile: options.hashFile, hash })).toBe(true)
    }
  })
})

describe('buildHelper', () => {
  it('compiles into a partial file, then installs the binary and the source hash next to it', () => {
    const { options, calls, outDir } = fixture()
    expect(buildHelper(options)).toBe('built')
    expect(calls).toEqual([{ compiler: options.compiler, args: compilerArguments(options.source, options.partial) }])
    expect(filesIn(outDir)).toEqual(['veydr-helper.exe', 'veydr-helper.sha256'])
    expect(readFileSync(options.hashFile, 'utf8')).toBe(`${sourceHash(options.source)}\n`)
  })

  it('skips the build while the source is unchanged, and rebuilds when it changes', () => {
    const { options, calls } = fixture()
    expect(buildHelper(options)).toBe('built')
    expect(buildHelper(options)).toBe('up-to-date')
    expect(calls).toHaveLength(1)
    writeFileSync(options.source, 'class B {}')
    expect(buildHelper(options)).toBe('built')
    expect(calls).toHaveLength(2)
    expect(readFileSync(options.hashFile, 'utf8').trim()).toBe(createHash('sha256').update('class B {}').digest('hex'))
  })

  it('rebuilds when the binary or the hash file is missing', () => {
    const { options, calls } = fixture()
    buildHelper(options)
    rmSync(options.binary)
    expect(buildHelper(options)).toBe('built')
    rmSync(options.hashFile)
    expect(buildHelper(options)).toBe('built')
    expect(calls).toHaveLength(3)
  })

  it('fails with the compiler output when compilation fails, and leaves nothing an earlier build produced', () => {
    const { options, outDir, failing } = fixture()
    buildHelper(options)
    writeFileSync(options.source, 'broken')
    const failed = failing({ status: 1, output: 'veydr-helper.cs(3,1): error CS1002: ; expected' })
    expect(() => buildHelper(failed)).toThrow(BuildError)
    expect(() => buildHelper(failed)).toThrow('csc.exe exited with 1:\nveydr-helper.cs(3,1): error CS1002: ; expected')
    expect(filesIn(outDir)).toEqual([])
  })

  it('removes a partial file the compiler left behind when it fails', () => {
    const { options, outDir } = fixture()
    const run: Run = (_compiler, args) => {
      writeFileSync(args.find((a) => a.startsWith('/out:'))?.slice('/out:'.length) ?? '', 'half')
      return { status: 1, output: 'error' }
    }
    expect(() => buildHelper({ ...options, run })).toThrow(BuildError)
    expect(filesIn(outDir)).toEqual([])
  })

  it('does not install a binary when the source changed while it was being compiled', () => {
    const { options, outDir } = fixture()
    const run: Run = (compiler, args) => {
      writeFileSync(options.source, 'class Changed {}')
      return options.run(compiler, args)
    }
    expect(() => buildHelper({ ...options, run })).toThrow('changed during the build; run the build again')
    expect(filesIn(outDir)).toEqual([])
    // The next run, with the source now stable, builds it.
    expect(buildHelper(options)).toBe('built')
  })

  it('fails when the compiler cannot run, naming the reason', () => {
    const { failing, outDir } = fixture()
    expect(() => buildHelper(failing({ status: null, output: '', error: new Error('spawnSync csc.exe ETIMEDOUT') }))).toThrow('csc.exe spawnSync csc.exe ETIMEDOUT')
    expect(filesIn(outDir)).toEqual([])
  })

  it('fails when the compiler does not exist, without running anything', () => {
    const { options, calls } = fixture()
    const compiler = join(resolve(options.source, '..'), 'missing', 'csc.exe')
    expect(() => buildHelper({ ...options, compiler })).toThrow(`the .NET Framework compiler was not found at ${compiler}`)
    expect(calls).toEqual([])
  })

  it('fails with the Windows-only message on any other system, before it reads the source or runs anything', () => {
    const { options, calls, outDir } = fixture()
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      expect(() => buildHelper({ ...options, platform, source: join(outDir, 'missing.cs') }), platform).toThrow(NOT_WINDOWS_MESSAGE)
    }
    expect(NOT_WINDOWS_MESSAGE).toBe('the Windows helper can only be built on Windows')
    expect(calls).toEqual([])
    expect(existsSync(outDir)).toBe(false)
  })
})

describe('runBuildCli', () => {
  const capture = (): { lines: string[]; errors: string[]; output: { stdout: (l: string) => void; stderr: (l: string) => void } } => {
    const lines: string[] = []
    const errors: string[] = []
    return { lines, errors, output: { stdout: (l) => lines.push(l), stderr: (l) => errors.push(l) } }
  }

  it('exits 0 and says whether it built the helper or found it up to date, naming the binary', () => {
    const { options } = fixture()
    const first = capture()
    expect(runBuildCli([], options, first.output)).toBe(0)
    expect(first.lines).toEqual([`built ${options.binary}`])
    const second = capture()
    expect(runBuildCli([], options, second.output)).toBe(0)
    expect(second.lines).toEqual([`${options.binary} is up to date`])
    expect([...first.errors, ...second.errors]).toEqual([])
  })

  it('exits 1 with the compiler output on a failed build', () => {
    const { failing } = fixture()
    const { lines, errors, output } = capture()
    expect(runBuildCli([], failing({ status: 1, output: 'error CS0103: no such name' }), output)).toBe(1)
    expect(lines).toEqual([])
    expect(errors).toEqual(['build-windows-helper: csc.exe exited with 1:\nerror CS0103: no such name'])
  })

  it('exits 1 with the Windows-only message on another system', () => {
    const { options } = fixture()
    const { errors, output } = capture()
    expect(runBuildCli([], { ...options, platform: 'linux' }, output)).toBe(1)
    expect(errors).toEqual([`build-windows-helper: ${NOT_WINDOWS_MESSAGE}`])
  })

  it('exits 2 with a usage line for an argument', () => {
    const { errors, output } = capture()
    expect(runBuildCli(['--force'], {}, output)).toBe(2)
    expect(errors).toEqual(['usage: node scripts/build-windows-helper.mjs'])
  })

  it('does not report an unexpected error as a build failure', () => {
    const { options } = fixture()
    expect(() => runBuildCli([], { ...options, source: join(options.source, 'no', 'such') }, capture().output)).toThrow()
  })

  describe.skipIf(process.platform !== 'linux')('[linux-only: refusing to build where csc.exe cannot exist]', () => {
    it('exits 1 with the message on stderr when run as a script', () => {
      const run = spawnSync(process.execPath, [join(root, 'scripts', 'build-windows-helper.mjs')], { encoding: 'utf8' })
      expect(run.status).toBe(1)
      expect(run.stdout).toBe('')
      expect(run.stderr.trim()).toBe(`build-windows-helper: ${NOT_WINDOWS_MESSAGE}`)
    })
  })
})
