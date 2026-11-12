import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WINDOWS_ICON_PATH, WINDOWS_ICON_SIZES, buildIco, parseIco, pngSize, writeWindowsIcon } from '../../scripts/windows-icon.mjs'

// The committed Windows icon (add-windows-packaging design D1, task 2.1): six PNG entries whose bytes
// equal the committed PNGs that `scripts/render-icons.cjs` renders for the Linux packages.

const root = resolve(__dirname, '../..')
const png = (size: number): Buffer => readFileSync(join(root, 'build/icons', `${size}x${size}.png`))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('build/windows/icon.ico', () => {
  it('is the file electron-builder.yml names, outside the Linux icon set', () => {
    expect(WINDOWS_ICON_PATH).toBe(join(root, 'build', 'windows', 'icon.ico'))
    expect(readFileSync(join(root, 'electron-builder.yml'), 'utf8')).toMatch(/^ {2}icon: build\/windows\/icon\.ico$/m)
  })

  it('holds exactly the six sizes, each entry the committed PNG of that size', () => {
    const entries = parseIco(readFileSync(WINDOWS_ICON_PATH))
    expect(entries.map((e) => e.width)).toEqual([16, 32, 48, 64, 128, 256])
    expect(WINDOWS_ICON_SIZES).toEqual([16, 32, 48, 64, 128, 256])
    for (const entry of entries) {
      expect(entry.height, `${entry.width}`).toBe(entry.width)
      expect(entry.planes, `${entry.width}`).toBe(1)
      expect(entry.bitCount, `${entry.width}`).toBe(32)
      expect(pngSize(entry.data), `${entry.width}`).toEqual({ width: entry.width, height: entry.width })
      expect(entry.data.equals(png(entry.width)), `${entry.width}`).toBe(true)
    }
  })

  it('is what the writer produces from the committed PNGs (the file is up to date)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-ico-'))
    dirs.push(dir)
    const output = writeWindowsIcon({ output: join(dir, 'icon.ico') })
    expect(readFileSync(output).equals(readFileSync(WINDOWS_ICON_PATH))).toBe(true)
  })
})

describe('the ICO writer', () => {
  it('stores 256 px as 0 in the directory and reads it back as 256', () => {
    const ico = buildIco([png(256)])
    expect(ico.readUInt8(6)).toBe(0)
    expect(ico.readUInt8(7)).toBe(0)
    expect(parseIco(ico)[0]?.width).toBe(256)
  })

  it('refuses non-PNG data, non-square, oversized and repeated sizes, and an empty list', () => {
    expect(() => buildIco([])).toThrow(/1 to 65535/)
    expect(() => buildIco([Buffer.from('not a png at all, just some bytes')])).toThrow(/not a PNG/)
    expect(() => buildIco([png(16), png(16)])).toThrow(/duplicate icon size 16/)
    expect(() => buildIco([png(512)])).toThrow(/1 to 256 px, got 512x512/)
    const wide = Buffer.from(png(16))
    wide.writeUInt32BE(17, 16)
    expect(() => buildIco([wide])).toThrow(/square/)
  })

  it('rejects a file that is not an ICO, or whose entry points outside it', () => {
    expect(() => parseIco(Buffer.from([0, 0, 2, 0, 0, 0]))).toThrow(/not an ICO/)
    const ico = buildIco([png(16)])
    expect(() => parseIco(ico.subarray(0, 10))).toThrow(/truncated/)
    const broken = Buffer.from(ico)
    broken.writeUInt32LE(ico.length, 6 + 12)
    expect(() => parseIco(broken)).toThrow(/outside the file/)
  })

  it('fails without writing when a PNG is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veydr-ico-'))
    dirs.push(dir)
    writeFileSync(join(dir, '16x16.png'), png(16))
    expect(() => writeWindowsIcon({ pngDir: dir, output: join(dir, 'out', 'icon.ico') })).toThrow(/ENOENT/)
  })
})
