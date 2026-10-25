import { describe, expect, it } from 'vitest'
import { applySgr, DEFAULT_STYLE, parseAnsi, stripAnsi, type AnsiStyle } from '../../src/shared/ansi'

const ESC = '\u001b'
const CSI = `${ESC}[`
const OSC = `${ESC}]`
const ST = `${ESC}\\`
const BEL = '\u0007'

const style = (overrides: Partial<AnsiStyle>): AnsiStyle => ({ ...DEFAULT_STYLE, ...overrides })

describe('ANSI SGR', () => {
  it('[spec:process-logs/color-codes] turns color codes into styled spans without the escape codes', () => {
    expect(parseAnsi(`plain ${CSI}31mred${CSI}0m done`)).toEqual([
      { text: 'plain ', style: DEFAULT_STYLE },
      { text: 'red', style: style({ fg: { kind: 'palette', index: 1 } }) },
      { text: ' done', style: DEFAULT_STYLE },
    ])
  })

  it('supports 16, 256, and true colors, foreground and background, in ; and : forms', () => {
    expect(applySgr(DEFAULT_STYLE, '92;104')).toEqual(style({ fg: { kind: 'palette', index: 10 }, bg: { kind: 'palette', index: 12 } }))
    expect(applySgr(DEFAULT_STYLE, '38;5;208;48;5;17')).toEqual(style({ fg: { kind: 'palette', index: 208 }, bg: { kind: 'palette', index: 17 } }))
    expect(applySgr(DEFAULT_STYLE, '38;2;1;2;3;48;2;250;251;252')).toEqual(style({ fg: { kind: 'rgb', r: 1, g: 2, b: 3 }, bg: { kind: 'rgb', r: 250, g: 251, b: 252 } }))
    expect(applySgr(DEFAULT_STYLE, '38:2::1:2:3')).toEqual(style({ fg: { kind: 'rgb', r: 1, g: 2, b: 3 } }))
    expect(applySgr(DEFAULT_STYLE, '38:2:1:2:3')).toEqual(style({ fg: { kind: 'rgb', r: 1, g: 2, b: 3 } }))
    expect(applySgr(DEFAULT_STYLE, '48:5:99')).toEqual(style({ bg: { kind: 'palette', index: 99 } }))
  })

  it('supports bold, dim, italic, underline, inverse and their resets', () => {
    const all = applySgr(DEFAULT_STYLE, '1;2;3;4;7')
    expect(all).toEqual(style({ bold: true, dim: true, italic: true, underline: true, inverse: true }))
    expect(applySgr(all, '22;23;24;27')).toEqual(DEFAULT_STYLE)
    expect(applySgr(all, '')).toEqual(DEFAULT_STYLE)
    expect(applySgr(style({ underline: true }), '4:0')).toEqual(DEFAULT_STYLE)
    expect(applySgr(style({ fg: { kind: 'palette', index: 1 }, bg: { kind: 'palette', index: 2 } }), '39;49')).toEqual(DEFAULT_STYLE)
  })

  it('ignores unknown codes and malformed or out-of-range colors', () => {
    expect(applySgr(DEFAULT_STYLE, '5;8;9;53')).toEqual(DEFAULT_STYLE)
    expect(applySgr(DEFAULT_STYLE, '38;5;256')).toEqual(DEFAULT_STYLE)
    expect(applySgr(DEFAULT_STYLE, '38;2;1;2')).toEqual(DEFAULT_STYLE)
    expect(applySgr(DEFAULT_STYLE, '38;5')).toEqual(DEFAULT_STYLE)
    expect(applySgr(DEFAULT_STYLE, '38:5:')).toEqual(DEFAULT_STYLE)
    expect(applySgr(DEFAULT_STYLE, '38;5;300;1')).toEqual(style({ bold: true }))
  })

  it('does not carry a style over to the next line (each line is parsed on its own)', () => {
    expect(parseAnsi('next line')).toEqual([{ text: 'next line', style: DEFAULT_STYLE }])
  })

  it('merges adjacent text of the same style', () => {
    expect(parseAnsi(`${CSI}1ma${CSI}1mb${CSI}0m${CSI}0mc`)).toEqual([
      { text: 'ab', style: style({ bold: true }) },
      { text: 'c', style: DEFAULT_STYLE },
    ])
  })
})

describe('ANSI removal', () => {
  it('[spec:process-logs/dangerous-escape-sequences] removes clipboard (OSC 52), hyperlink (OSC 8), title, and cursor sequences without effect', () => {
    const cases: [string, string][] = [
      [`a${OSC}52;c;ZXZpbA==${BEL}b`, 'ab'],
      [`a${OSC}52;c;ZXZpbA==${ST}b`, 'ab'],
      [`${OSC}8;;https://evil.example/${ST}click${OSC}8;;${ST}`, 'click'],
      [`${OSC}0;new title${BEL}text`, 'text'],
      [`${OSC}2;title${ST}text`, 'text'],
      [`x${CSI}2J${CSI}H${CSI}10;20H${CSI}?25l${CSI}1A${CSI}K${CSI}6ny`, 'xy'],
      [`${ESC}7saved${ESC}8${ESC}c${ESC}(B${ESC}M`, 'saved'],
      [`${ESC}P+q544e${ST}dcs`, 'dcs'],
      [`${ESC}_apc${ST}${ESC}^pm${ST}${ESC}Xsos${ST}ok`, 'ok'],
      [`unterminated ${OSC}52;c;ZXZpbA==`, 'unterminated '],
      [`${CSI}>4;2mkeys`, 'keys'],
    ]
    for (const [input, expected] of cases) {
      expect(stripAnsi(input), JSON.stringify(input)).toBe(expected)
      // Nothing in these sequences is styling either.
      expect(parseAnsi(input), JSON.stringify(input)).toEqual([{ text: expected, style: DEFAULT_STYLE }])
    }
  })

  it('removes the 8-bit (C1) forms of escape sequences', () => {
    expect(stripAnsi('a\u009b31mb\u009d52;c;eA==\u009cc\u0090dcs\u009cd\u0085e')).toBe('abcde')
    // An 8-bit CSI with SGR parameters still styles.
    expect(parseAnsi('\u009b1mbold')).toEqual([{ text: 'bold', style: style({ bold: true }) }])
  })

  it('removes control characters except tab, and a malformed or cut-off sequence', () => {
    expect(stripAnsi('a\u0000b\u0008c\u0007d\u000be\u007ff\tg\rh')).toBe('abcdef\tgh')
    expect(stripAnsi(`end${ESC}`)).toBe('end')
    expect(stripAnsi(`end${CSI}12`)).toBe('end')
    expect(stripAnsi(`${CSI}31é`)).toBe('é')
    expect(stripAnsi(`${ESC}\u0007x`)).toBe('x')
  })

  it('keeps markup as text', () => {
    expect(stripAnsi('<script>alert(1)</script><img src=x onerror=alert(1)>')).toBe('<script>alert(1)</script><img src=x onerror=alert(1)>')
  })

  it('never outputs ESC or another control character, for random input (property test, three seeds)', () => {
    // Alphabet weighted towards sequence syntax so that partial and nested sequences occur often.
    const alphabet = [ESC, '[', ']', 'P', '_', '^', 'X', '\\', BEL, ';', ':', 'm', 'H', '?', '0', '1', '3', '8', '5', '2', 'a', ' ', '\t', '\u009b', '\u009c', '\u009d', '\u0090', '\u0085', '\u0000', '\r', '\u007f', 'é', '😀']
    for (const seed of [1, 0xc0ffee, 20261024]) {
      let state = seed
      const random = (): number => {
        state = (state * 1103515245 + 12345) % 2 ** 31
        return state / 2 ** 31
      }
      for (let n = 0; n < 2000; n++) {
        let input = ''
        const length = Math.floor(random() * 40)
        for (let i = 0; i < length; i++) input += alphabet[Math.floor(random() * alphabet.length)]
        const text = parseAnsi(input)
          .map((span) => span.text)
          .join('')
        expect(text, JSON.stringify(input)).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/)
        expect(stripAnsi(input)).toBe(text)
        expect(stripAnsi(text)).toBe(text)
      }
    }
  })
})
