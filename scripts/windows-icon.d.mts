// Types for scripts/windows-icon.mjs, so TypeScript tests can import it.

export const WINDOWS_ICON_SIZES: readonly number[]
export const WINDOWS_ICON_PATH: string
export const PNG_DIR: string

export interface IcoEntry {
  width: number
  height: number
  planes: number
  bitCount: number
  data: Buffer
}

export function pngSize(png: Buffer): { width: number; height: number }
export function buildIco(images: readonly Buffer[]): Buffer
export function parseIco(ico: Buffer): IcoEntry[]
export function writeWindowsIcon(options?: { pngDir?: string; output?: string }): string
