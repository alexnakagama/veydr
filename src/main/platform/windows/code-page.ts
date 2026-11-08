/**
 * The WHATWG encoding label of a Windows ANSI code page (`GetACP()`), used to decode a line of a
 * command's output that is not valid UTF-8 (add-windows-environment-and-commands design D5).
 *
 * Only the ANSI code pages with a WHATWG decoder are listed. Any other code page (an OEM code
 * page, 65001, or an unusual system setting) has no fallback: such a line is decoded as UTF-8 with
 * replacement characters, as on Linux.
 */
const ANSI_CODE_PAGE_LABELS: ReadonlyMap<number, string> = new Map([
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
])

/** The code pages `ansiCodePageLabel` knows, for tests and docs. */
export const KNOWN_ANSI_CODE_PAGES: readonly number[] = [...ANSI_CODE_PAGE_LABELS.keys()]

/** The WHATWG label for `codePage`, or `null` if it has none in the table above. */
export function ansiCodePageLabel(codePage: number): string | null {
  return ANSI_CODE_PAGE_LABELS.get(codePage) ?? null
}
