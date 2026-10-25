import type { CSSProperties } from 'react'
import type { AnsiColor, AnsiStyle } from '../../shared/ansi'

/** The 16 base colors (normal, then bright), tuned for the dark theme. */
const BASE_COLORS = [
  '#3b4048',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#61afef',
  '#c678dd',
  '#56b6c2',
  '#d4d8df',
  '#7f848e',
  '#ff8a94',
  '#b8e994',
  '#ffd88a',
  '#84c5ff',
  '#e3a6f5',
  '#7fdde6',
  '#ffffff',
] as const

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

/** CSS color of an SGR color: the 16 base colors, the 6×6×6 cube, the gray ramp, or true color. */
export function colorCss(color: AnsiColor): string {
  if (color.kind === 'rgb') return `rgb(${color.r}, ${color.g}, ${color.b})`
  const index = color.index
  if (index < 16) return BASE_COLORS[index] ?? BASE_COLORS[7]
  if (index < 232) {
    const cube = index - 16
    const level = (n: number): number => CUBE_LEVELS[n] ?? 0
    return `rgb(${level(Math.floor(cube / 36))}, ${level(Math.floor(cube / 6) % 6)}, ${level(cube % 6)})`
  }
  const gray = 8 + (index - 232) * 10
  return `rgb(${gray}, ${gray}, ${gray})`
}

/**
 * Inline style for a span (set through the DOM style API, which the CSP's `style-src 'self'`
 * allows); `undefined` for the default style.
 */
export function spanStyle(style: AnsiStyle): CSSProperties | undefined {
  let fg = style.fg === null ? undefined : colorCss(style.fg)
  let bg = style.bg === null ? undefined : colorCss(style.bg)
  if (style.inverse) [fg, bg] = [bg ?? 'var(--log-bg)', fg ?? 'var(--text)']
  const css: CSSProperties = {}
  if (fg !== undefined) css.color = fg
  if (bg !== undefined) css.backgroundColor = bg
  if (style.bold) css.fontWeight = 700
  if (style.dim) css.opacity = 0.65
  if (style.italic) css.fontStyle = 'italic'
  if (style.underline) css.textDecoration = 'underline'
  return Object.keys(css).length === 0 ? undefined : css
}
