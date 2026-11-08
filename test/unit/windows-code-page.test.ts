import { describe, expect, it } from 'vitest'
import { ansiCodePageLabel, KNOWN_ANSI_CODE_PAGES } from '../../src/main/platform/windows/code-page'

describe('ANSI code page labels (add-windows-environment-and-commands design D5)', () => {
  it.each([
    [874, 'windows-874'],
    [1250, 'windows-1250'],
    [1251, 'windows-1251'],
    [1252, 'windows-1252'],
    [1253, 'windows-1253'],
    [1254, 'windows-1254'],
    [1255, 'windows-1255'],
    [1256, 'windows-1256'],
    [1257, 'windows-1257'],
    [1258, 'windows-1258'],
    [932, 'shift_jis'],
    [936, 'gbk'],
    [949, 'euc-kr'],
    [950, 'big5'],
  ])('maps code page %i to %s', (codePage, label) => {
    expect(ansiCodePageLabel(codePage)).toBe(label)
  })

  it('knows exactly the code pages of the design', () => {
    expect([...KNOWN_ANSI_CODE_PAGES].sort((a, b) => a - b)).toEqual([874, 932, 936, 949, 950, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258])
  })

  it.each([
    [437, 'an OEM code page'],
    [850, 'an OEM code page'],
    [65001, 'UTF-8, which needs no fallback'],
    [1200, 'UTF-16'],
    [0, 'zero'],
    [12345, 'an unknown code page'],
  ])('has no label for %i (%s)', (codePage) => {
    expect(ansiCodePageLabel(codePage)).toBeNull()
  })

  it('names only encodings this runtime can decode, each under its own canonical name', () => {
    for (const codePage of KNOWN_ANSI_CODE_PAGES) {
      const label = ansiCodePageLabel(codePage)
      expect(label).not.toBeNull()
      expect(new TextDecoder(label ?? '').encoding).toBe(label)
    }
  })
})
