import { describe, expect, it } from 'vitest'
import { createEnvironmentService, effectiveEnvironment, previewEntries } from '../../src/main/projects/environment'
import { parseMarkedEnvironment } from '../../src/main/platform/linux/environment'

describe('environment service', () => {
  it('resolves the base environment once per session, again on refresh, and reports warnings', async () => {
    let calls = 0
    const warned: (readonly string[])[] = []
    const service = createEnvironmentService({
      provider: { base: () => Promise.resolve({ env: { N: String(++calls) }, warnings: calls > 1 ? ['fallback'] : [] }) },
      onWarnings: (w) => warned.push(w),
    })
    expect((await service.base()).env).toEqual({ N: '1' })
    expect((await service.base()).env).toEqual({ N: '1' })
    expect(await service.refresh()).toEqual({ env: { N: '2' }, warnings: ['fallback'] })
    expect((await service.base()).env).toEqual({ N: '2' })
    expect(warned).toEqual([[], ['fallback']])
  })

  it('does not keep a failed resolution', async () => {
    let fail = true
    const service = createEnvironmentService({
      provider: { base: () => (fail ? Promise.reject(new Error('unsupported')) : Promise.resolve({ env: { A: '1' }, warnings: [] })) },
    })
    await expect(service.base()).rejects.toThrow('unsupported')
    fail = false
    expect((await service.base()).env).toEqual({ A: '1' })
  })

  it('[spec:project-registry/override-applied] applies overrides last and masks secret overrides in the preview', () => {
    const base = { PATH: '/usr/bin', PORT: '80', TOKEN: 'from-login' }
    const overrides = [
      { key: 'PORT', value: '3000', secret: false },
      { key: 'TOKEN', value: 'hunter2', secret: true },
    ]
    expect(effectiveEnvironment(base, overrides, 'exact')).toEqual({ PATH: '/usr/bin', PORT: '3000', TOKEN: 'hunter2' })
    const preview = previewEntries(base, { env: overrides }, 'exact')
    expect(preview).toEqual([
      { key: 'PATH', secret: false, value: '/usr/bin', source: 'base' },
      { key: 'PORT', secret: false, value: '3000', source: 'override' },
      { key: 'TOKEN', secret: true, value: null, source: 'override' },
    ])
    expect(JSON.stringify(preview)).not.toContain('hunter2')
  })

  it('[spec:project-registry/override-differing-in-case-on-windows] replaces the base variable of any case, keeping the override name', () => {
    const base = { Path: 'C:\\Windows', TEMP: 'C:\\Temp' }
    const overrides = [{ key: 'PATH', value: 'C:\\Tools', secret: false }]
    expect(effectiveEnvironment(base, overrides, 'case-insensitive')).toEqual({ PATH: 'C:\\Tools', TEMP: 'C:\\Temp' })
    expect(previewEntries(base, { env: overrides }, 'case-insensitive')).toEqual([
      { key: 'PATH', secret: false, value: 'C:\\Tools', source: 'override' },
      { key: 'TEMP', secret: false, value: 'C:\\Temp', source: 'base' },
    ])
  })

  it('[spec:project-registry/override-differing-in-case-on-linux] keeps a base variable differing from the override only in case', () => {
    const base = { Path: '/opt/bin', TEMP: '/tmp' }
    const overrides = [{ key: 'PATH', value: '/usr/bin', secret: false }]
    expect(effectiveEnvironment(base, overrides, 'exact')).toEqual({ Path: '/opt/bin', PATH: '/usr/bin', TEMP: '/tmp' })
    expect(previewEntries(base, { env: overrides }, 'exact')).toEqual([
      { key: 'PATH', secret: false, value: '/usr/bin', source: 'override' },
      { key: 'Path', secret: false, value: '/opt/bin', source: 'base' },
      { key: 'TEMP', secret: false, value: '/tmp', source: 'base' },
    ])
  })

  it('replaces every base spelling of an overridden variable and masks a secret override under a case-insensitive rule', () => {
    const base = { Path: 'a', path: 'b', Other: 'c' }
    const overrides = [{ key: 'PATH', value: 'secret-path', secret: true }]
    expect(effectiveEnvironment(base, overrides, 'case-insensitive')).toEqual({ Other: 'c', PATH: 'secret-path' })
    expect(previewEntries(base, { env: overrides }, 'case-insensitive')).toEqual([
      { key: 'Other', secret: false, value: 'c', source: 'base' },
      { key: 'PATH', secret: true, value: null, source: 'override' },
    ])
  })
})

describe('login shell output parsing', () => {
  it('reads only what is between the markers and skips entries without a name', () => {
    const output = `motd banner\n__S__A=1\0B=x=y\0MULTI=line1\nline2\0=noname\0junk\0__E__trailing noise`
    expect(parseMarkedEnvironment(output, '__S__', '__E__')).toEqual({ A: '1', B: 'x=y', MULTI: 'line1\nline2' })
    expect(parseMarkedEnvironment('no markers', '__S__', '__E__')).toBeNull()
    expect(parseMarkedEnvironment('__S__A=1\0', '__S__', '__E__')).toBeNull()
  })
})

describe('editor arguments', () => {
  it('substitutes the project path literally, even when it contains $ replacement patterns', async () => {
    const { editorArguments } = await import('../../src/main/projects/desktop')
    for (const path of ['/home/u/$$proj', '/h/$&x', "/h/$'a", '/h/$`b', '/h/$1']) {
      expect(editorArguments(['--goto={path}:1', '{path}', 'plain'], path)).toEqual([`--goto=${path}:1`, path, 'plain'])
    }
  })
})
