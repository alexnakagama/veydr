// Builds the Windows icon `build/windows/icon.ico` from the committed PNGs in `build/icons/`
// (add-windows-packaging design D1). `scripts/render-icons.cjs` calls `writeWindowsIcon` after it
// renders the PNGs; the file is committed like them.
//
// Each size is stored as a PNG entry (supported since Windows Vista), so the bytes of every entry
// equal the committed PNG of that size; `test/unit/windows-icon.test.ts` checks that.
// Format: https://learn.microsoft.com/en-us/previous-versions/ms997538(v=msdn.10)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** The sizes the ICO holds; 256 is the largest an ICO directory entry can describe. */
export const WINDOWS_ICON_SIZES = Object.freeze([16, 32, 48, 64, 128, 256])
export const WINDOWS_ICON_PATH = join(root, 'build', 'windows', 'icon.ico')
export const PNG_DIR = join(root, 'build', 'icons')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HEADER_SIZE = 6
const ENTRY_SIZE = 16

/** Width and height from a PNG's IHDR chunk; throws for anything that is not a PNG. */
export function pngSize(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG image')
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * An ICO file holding `images` as PNG entries, in the given order. Each image must be a square PNG
 * of 1 to 256 pixels, and no size may repeat.
 */
export function buildIco(images) {
  if (!Array.isArray(images) || images.length === 0 || images.length > 0xffff) throw new Error('an icon needs 1 to 65535 images')
  const seen = new Set()
  const sizes = images.map((png) => {
    const { width, height } = pngSize(png)
    if (width !== height || width < 1 || width > 256) throw new Error(`an icon entry must be square and 1 to 256 px, got ${width}x${height}`)
    if (seen.has(width)) throw new Error(`duplicate icon size ${width}`)
    seen.add(width)
    return width
  })
  const header = Buffer.alloc(HEADER_SIZE)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const directory = Buffer.alloc(ENTRY_SIZE * images.length)
  let offset = HEADER_SIZE + directory.length
  images.forEach((png, i) => {
    const at = i * ENTRY_SIZE
    const size = sizes[i] === 256 ? 0 : sizes[i] // 0 means 256
    directory.writeUInt8(size, at)
    directory.writeUInt8(size, at + 1)
    directory.writeUInt8(0, at + 2) // no palette
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([header, directory, ...images])
}

/** The entries of an ICO file: each with its directory fields and its image bytes. */
export function parseIco(ico) {
  if (!Buffer.isBuffer(ico) || ico.length < HEADER_SIZE) throw new Error('not an ICO file')
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('not an ICO file')
  const count = ico.readUInt16LE(4)
  if (ico.length < HEADER_SIZE + count * ENTRY_SIZE) throw new Error('truncated ICO directory')
  const entries = []
  for (let i = 0; i < count; i += 1) {
    const at = HEADER_SIZE + i * ENTRY_SIZE
    const bytes = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    if (offset + bytes > ico.length) throw new Error(`ICO entry ${i} lies outside the file`)
    entries.push({
      width: ico.readUInt8(at) || 256,
      height: ico.readUInt8(at + 1) || 256,
      planes: ico.readUInt16LE(at + 4),
      bitCount: ico.readUInt16LE(at + 6),
      data: ico.subarray(offset, offset + bytes),
    })
  }
  return entries
}

/** Writes the ICO from `<pngDir>/<size>x<size>.png`; replaces the file in one rename. */
export function writeWindowsIcon({ pngDir = PNG_DIR, output = WINDOWS_ICON_PATH } = {}) {
  const ico = buildIco(WINDOWS_ICON_SIZES.map((size) => readFileSync(join(pngDir, `${size}x${size}.png`))))
  mkdirSync(dirname(output), { recursive: true })
  const partial = `${output}.partial`
  writeFileSync(partial, ico)
  renameSync(partial, output)
  return output
}
