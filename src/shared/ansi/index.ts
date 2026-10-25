/**
 * Terminal escape handling for process output (design D11, spec: safe rendering of output).
 *
 * Select Graphic Rendition (SGR, `ESC [ … m`) sequences become styles: 16, 256, and true colors
 * for foreground and background, bold, dim, italic, underline, and inverse. Every other escape or
 * control sequence is removed without being interpreted: other CSI sequences (cursor movement,
 * erasing, …), OSC (window title, hyperlinks, clipboard access), DCS, SOS, PM, APC, two-character
 * escapes, their 8-bit C1 forms, and every C0 control character except tab. The result is plain
 * text that is only ever rendered as text.
 *
 * Each line is processed on its own: a style set on one line does not carry over to the next.
 *
 * Shared by main and renderer; no dependencies.
 */

export type AnsiColor = { readonly kind: 'palette'; readonly index: number } | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number }

export interface AnsiStyle {
  readonly fg: AnsiColor | null
  readonly bg: AnsiColor | null
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
}

export interface AnsiSpan {
  readonly text: string
  readonly style: AnsiStyle
}

export const DEFAULT_STYLE: AnsiStyle = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false })

const ESC = 0x1b
const BEL = 0x07
const TAB = 0x09
const DEL = 0x7f
// 8-bit (C1) forms of the sequence introducers and the string terminator.
const C1_DCS = 0x90
const C1_SOS = 0x98
const C1_CSI = 0x9b
const C1_ST = 0x9c
const C1_OSC = 0x9d
const C1_PM = 0x9e
const C1_APC = 0x9f

/** Strings that run until a string terminator: OSC, DCS, SOS, PM, APC. */
type StringKind = 'osc' | 'other'

const isC0 = (code: number): boolean => code < 0x20 || code === DEL
const isC1 = (code: number): boolean => code >= 0x80 && code <= 0x9f

/**
 * Index just past a control string (OSC/DCS/SOS/PM/APC) whose content starts at `from`: after its
 * terminator (ST as `ESC \` or 0x9C; BEL also ends an OSC), or the end of the text if it has none.
 */
function skipString(text: string, from: number, kind: StringKind): number {
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === C1_ST) return i + 1
    if (code === BEL && kind === 'osc') return i + 1
    if (code === ESC) {
      // `ESC \` terminates; any other ESC aborts the string and starts a new sequence.
      return text.charCodeAt(i + 1) === 0x5c ? i + 2 : i
    }
  }
  return text.length
}

/**
 * Parses a CSI sequence whose parameters start at `from`. Returns the index after it and, for a
 * well-formed SGR sequence, its parameter string. A malformed sequence ends before the offending
 * character, which is then processed on its own (and removed if it is a control character).
 */
function parseCsi(text: string, from: number): { end: number; sgr: string | null } {
  let i = from
  // Parameter bytes 0x30–0x3F, then intermediate bytes 0x20–0x2F, then one final byte 0x40–0x7E.
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code < 0x30 || code > 0x3f) break
    i++
  }
  const paramsEnd = i
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code > 0x2f) break
    i++
  }
  if (i >= text.length) return { end: text.length, sgr: null }
  const final = text.charCodeAt(i)
  if (final < 0x40 || final > 0x7e) return { end: i, sgr: null }
  const params = text.slice(from, paramsEnd)
  const isSgr = final === 0x6d && paramsEnd === i && /^[0-9;:]*$/.test(params)
  return { end: i + 1, sgr: isSgr ? params : null }
}

/** Index after a two-character (nF/Fp/Fe/Fs) escape sequence starting after its ESC at `from`. */
function skipEscape(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code > 0x2f) break
    i++
  }
  if (i >= text.length) return text.length
  const final = text.charCodeAt(i)
  // A final byte ends the sequence; anything else (e.g. a control character) aborts it.
  return final >= 0x30 && final <= 0x7e ? i + 1 : i
}

const byte = (value: number | undefined): number | null => (value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255 ? value : null)

/**
 * Reads an extended color (`38`/`48` arguments) from `params` starting at `index` (after the 38/48):
 * `5;n` (256 colors) or `2;r;g;b` (true color), in either the `;` or the `:` form. Returns the
 * color (or `null` if malformed) and how many parameters it used.
 */
function extendedColor(params: readonly (number | readonly number[])[], index: number): { color: AnsiColor | null; used: number } {
  const next = params[index]
  if (next === undefined) return { color: null, used: 0 }
  if (typeof next !== 'number') {
    // Colon form `38:5:n` / `38:2:[colorspace]:r:g:b`, already grouped (the group includes 38/48).
    return { color: null, used: 0 }
  }
  if (next === 5) {
    const index256 = byte(params[index + 1] as number | undefined)
    return { color: index256 === null ? null : { kind: 'palette', index: index256 }, used: 2 }
  }
  if (next === 2) {
    const [r, g, b] = [byte(params[index + 1] as number | undefined), byte(params[index + 2] as number | undefined), byte(params[index + 3] as number | undefined)]
    return { color: r === null || g === null || b === null ? null : { kind: 'rgb', r, g, b }, used: 4 }
  }
  return { color: null, used: 1 }
}

/** The color of a colon-form group `[38|48, 5, n]` or `[38|48, 2, (colorspace,) r, g, b]`. */
function colonColor(group: readonly number[]): AnsiColor | null {
  if (group[1] === 5 && group.length === 3) {
    const index = byte(group[2])
    return index === null ? null : { kind: 'palette', index }
  }
  if (group[1] === 2 && (group.length === 5 || group.length === 6)) {
    const [r, g, b] = group.slice(-3).map(byte)
    return r === null || g === null || b === null || r === undefined || g === undefined || b === undefined ? null : { kind: 'rgb', r, g, b }
  }
  return null
}

/** Applies the SGR parameters `params` (e.g. `"1;31"`) to `style`. Unknown codes are ignored. */
export function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  // Parameters are `;`-separated; a `:`-separated group belongs to one code (e.g. `38:2::1:2:3`).
  const parsed: (number | number[])[] = (params === '' ? ['0'] : params.split(';')).map((part) => {
    if (!part.includes(':')) return part === '' ? 0 : Number(part)
    return part.split(':').map((sub) => (sub === '' ? Number.NaN : Number(sub)))
  })
  let next: { -readonly [K in keyof AnsiStyle]: AnsiStyle[K] } = { ...style }
  for (let i = 0; i < parsed.length; i++) {
    const param = parsed[i]
    if (param === undefined) continue
    if (typeof param !== 'number') {
      const [code] = param
      if (code === 38 || code === 48) {
        // Colorspace ID may be empty (`38:2::r:g:b`); drop it before reading the components.
        const group = param[1] === 2 && param.length === 6 ? [code, 2, ...param.slice(3)] : param
        const color = colonColor(group)
        if (color !== null) next = code === 38 ? { ...next, fg: color } : { ...next, bg: color }
      } else if (code === 4) {
        next = { ...next, underline: param[1] !== 0 }
      }
      continue
    }
    const code = param
    if (code === 0) next = { ...DEFAULT_STYLE }
    else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 7) next.inverse = true
    else if (code === 22) next = { ...next, bold: false, dim: false }
    else if (code === 23) next.italic = false
    else if (code === 24) next.underline = false
    else if (code === 27) next.inverse = false
    else if (code >= 30 && code <= 37) next.fg = { kind: 'palette', index: code - 30 }
    else if (code === 39) next.fg = null
    else if (code >= 40 && code <= 47) next.bg = { kind: 'palette', index: code - 40 }
    else if (code === 49) next.bg = null
    else if (code >= 90 && code <= 97) next.fg = { kind: 'palette', index: code - 90 + 8 }
    else if (code >= 100 && code <= 107) next.bg = { kind: 'palette', index: code - 100 + 8 }
    else if (code === 38 || code === 48) {
      const { color, used } = extendedColor(parsed, i + 1)
      if (color !== null) next = code === 38 ? { ...next, fg: color } : { ...next, bg: color }
      i += used
    }
  }
  return next
}

/**
 * Splits `text` into styled spans, removing every escape and control sequence (see the module
 * comment). Adjacent text with the same style forms one span; empty spans are omitted.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let style = DEFAULT_STYLE
  let current = ''

  const emit = (): void => {
    if (current === '') return
    const last = spans[spans.length - 1]
    if (last !== undefined && sameStyle(last.style, style)) spans[spans.length - 1] = { text: last.text + current, style: last.style }
    else spans.push({ text: current, style })
    current = ''
  }
  const setStyle = (next: AnsiStyle): void => {
    if (sameStyle(next, style)) return
    emit()
    style = next
  }

  let i = 0
  let plainFrom = 0
  const flushPlain = (until: number): void => {
    if (until > plainFrom) current += text.slice(plainFrom, until)
  }

  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code !== ESC && !isC1(code) && (!isC0(code) || code === TAB)) {
      i++
      continue
    }
    flushPlain(i)
    let end: number
    if (code === ESC) {
      const intro = text.charCodeAt(i + 1)
      if (Number.isNaN(intro)) end = i + 1
      else if (intro === 0x5b) {
        const csi = parseCsi(text, i + 2)
        if (csi.sgr !== null) setStyle(applySgr(style, csi.sgr))
        end = csi.end
      } else if (intro === 0x5d) end = skipString(text, i + 2, 'osc')
      else if (intro === 0x50 || intro === 0x58 || intro === 0x5e || intro === 0x5f) end = skipString(text, i + 2, 'other')
      else end = skipEscape(text, i + 1)
    } else if (code === C1_CSI) {
      const csi = parseCsi(text, i + 1)
      if (csi.sgr !== null) setStyle(applySgr(style, csi.sgr))
      end = csi.end
    } else if (code === C1_OSC) end = skipString(text, i + 1, 'osc')
    else if (code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC) end = skipString(text, i + 1, 'other')
    else end = i + 1 // any other C0 or C1 control character
    i = Math.max(end, i + 1)
    plainFrom = i
  }
  flushPlain(text.length)
  emit()
  return spans
}

/** The text of `text` without any escape or control sequence (tab kept): what copying yields. */
export function stripAnsi(text: string): string {
  // Fast path: nothing to remove.
  let clean = true
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === ESC || isC1(code) || (isC0(code) && code !== TAB)) {
      clean = false
      break
    }
  }
  if (clean) return text
  let out = ''
  for (const span of parseAnsi(text)) out += span.text
  return out
}

function sameColor(a: AnsiColor | null, b: AnsiColor | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'palette') return b.kind === 'palette' && a.index === b.index
  return b.kind === 'rgb' && a.r === b.r && a.g === b.g && a.b === b.b
}

export function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a === b ||
    (a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse && sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg))
  )
}
