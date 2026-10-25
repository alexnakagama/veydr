import { spawnSync } from 'node:child_process'
import { openSync, readdirSync, readSync, closeSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { requirePackages, unpackedDir } from './support'

/** Ubuntu 22.04 ships glibc 2.35, the oldest supported distribution (task 9.7). */
const GLIBC_FLOOR = [2, 35] as const

function isElf(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    return readSync(fd, magic, 0, 4, 0) === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  } finally {
    closeSync(fd)
  }
}

function elfFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) return elfFiles(path)
    return stat.isFile() && stat.size >= 4 && isElf(path) ? [path] : []
  })
}

/** Highest `GLIBC_x.y` version a binary's dynamic symbols require, from `objdump -T`. */
function highestGlibc(path: string): [number, number] | null {
  const out = spawnSync('objdump', ['-T', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (out.status !== 0) throw new Error(`objdump -T ${path} failed: ${out.stderr}`)
  let best: [number, number] | null = null
  for (const match of out.stdout.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const version: [number, number] = [Number(match[1]), Number(match[2])]
    if (best === null || version[0] > best[0] || (version[0] === best[0] && version[1] > best[1])) best = version
  }
  return best
}

beforeAll(() => requirePackages())

describe('glibc floor of the packaged binaries (task 9.7)', () => {
  it(`requires at most glibc ${GLIBC_FLOOR.join('.')}`, () => {
    const files = elfFiles(unpackedDir)
    expect(files.map((f) => relative(unpackedDir, f))).toContain('veydr')
    const required = files.map((file) => ({ file: relative(unpackedDir, file), glibc: highestGlibc(file) }))
    console.log(required.map((r) => `${r.glibc?.join('.') ?? 'none'}\t${r.file}`).join('\n'))
    for (const { file, glibc } of required) {
      if (glibc === null) continue
      expect(glibc[0] < GLIBC_FLOOR[0] || (glibc[0] === GLIBC_FLOOR[0] && glibc[1] <= GLIBC_FLOOR[1]), `${file} requires GLIBC_${glibc.join('.')}`).toBe(true)
    }
  })
})
