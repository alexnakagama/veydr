import { describe, expect, it } from 'vitest'
import type { PlatformLog } from '../../src/main/platform/types'
import { createWindowsPortInspector, filetimeToUnixMs } from '../../src/main/platform/windows/ports'
import { MAX_PORTS_OUTPUT_BYTES, ProtocolError } from '../../src/main/platform/windows/protocol'

// The Windows port inspector's mapping of the helper's `ports` line (add-windows-port-inspection
// design D4, task 3.1), on every system: no helper runs here, `readPorts` returns fixed lines.

/** 2024-01-01T00:00:00.000Z as a FILETIME, plus 9,999 ticks (0.9999 ms) that must be rounded down. */
const TAKEN = '133485408000009999'
const TAKEN_MS = Date.UTC(2024, 0, 1)
/** Created a minute before the fence, so a `known` owner the protocol accepts. */
const CREATED = String(BigInt(TAKEN) - 600_000_000n)

const NODE = { pid: 4248, state: 'known', created: CREATED, image: 'C:\\Program Files\\nodejs\\node.exe' }
const v4 = (port: number, pid: number, address = '7f000001') => ({ family: 'ipv4', address, port, pid })
const v6 = (port: number, pid: number, address = `${'0'.repeat(31)}1`) => ({ family: 'ipv6', address, port, pid })

const line = (listeners: readonly unknown[], owners: readonly unknown[], takenAt = TAKEN): string => `${JSON.stringify({ type: 'ports', takenAt, listeners, owners })}\n`

interface Recorded {
  readonly level: string
  readonly event: string
  readonly detail: Record<string, unknown> | undefined
}

function inspector(output: string | (() => Promise<string>)) {
  const logged: Recorded[] = []
  const log: PlatformLog = { record: (level, event, detail) => logged.push({ level, event, detail }) }
  const readPorts = typeof output === 'string' ? () => Promise.resolve(output) : output
  return { inspector: createWindowsPortInspector({ readPorts, log }), logged }
}

async function rejection(pending: Promise<unknown>): Promise<Error> {
  return pending.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error as Error,
  )
}

describe('Windows port inspector', () => {
  it('shows a known owner by PID, creation time and image name', async () => {
    const { inspector: ports, logged } = inspector(line([v4(5173, 4248), v6(5173, 4248)], [NODE]))
    const snapshot = await ports.list()
    const owner = { kind: 'known', processes: [{ identity: { pid: 4248, token: CREATED }, name: 'node.exe' }] }
    expect(snapshot).toEqual({
      takenAt: TAKEN_MS,
      ports: [
        { family: 'ipv4', address: '127.0.0.1', port: 5173, owner },
        { family: 'ipv6', address: '::1', port: 5173, owner },
      ],
    })
    expect(logged).toEqual([])
  })

  it('names a known owner without an image path, or with a bare name, as the helper reports it', async () => {
    const owners = [
      { ...NODE, pid: 4, image: 'System' },
      { ...NODE, pid: 5, image: '' },
      { ...NODE, pid: 6, image: 'C:\\odd\\' },
    ]
    const snapshot = await inspector(line([v4(1, 4), v4(2, 5), v4(3, 6)], owners)).inspector.list()
    expect(snapshot.ports.map((p) => (p.owner.kind === 'known' ? p.owner.processes.map((process) => process.name) : p.owner.kind))).toEqual([['System'], ['PID 5'], ['PID 6']])
  })

  it('shows a restricted owner as restricted, and a gone or erroneous one, PID 0 included, as unknown', async () => {
    const owners = [
      { pid: 4, state: 'restricted' },
      { pid: 5, state: 'gone' },
      { pid: 0, state: 'gone' },
      { pid: 7, state: 'error', code: 31 },
    ]
    const { inspector: ports, logged } = inspector(line([v4(1, 4), v4(2, 5), v4(3, 0), v4(4, 7)], owners))
    const snapshot = await ports.list()
    expect(logged).toEqual([{ level: 'warn', event: 'ports.owner-errors', detail: { '31': 1 } }])
    expect(snapshot.ports.map((p) => [p.port, p.owner])).toEqual([
      [1, { kind: 'restricted' }],
      [2, { kind: 'unknown' }],
      [3, { kind: 'unknown' }],
      [4, { kind: 'unknown' }],
    ])
  })

  it('[spec:port-inspection/reused-pid-not-shown-as-owner] shows an owner the helper reports as reused as unknown, never as the new process', async () => {
    // The holder of port 5173 exited after the tables were read, and PID 4248 now names a younger
    // process: the helper reports it as reused, and nothing of the new process reaches the view.
    const { inspector: ports, logged } = inspector(line([v4(5173, 4248), v6(5173, 4248)], [{ pid: 4248, state: 'reused' }]))
    const snapshot = await ports.list()
    expect(snapshot.ports.map((p) => p.owner)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }])
    expect(logged).toEqual([])
    // A known owner younger than the fence is refused rather than shown, so the rule cannot be bypassed by the helper either.
    const young = { ...NODE, created: String(BigInt(TAKEN) - 1n) }
    await expect(inspector(line([v4(5173, 4248)], [young])).inspector.list()).rejects.toThrow(/created after the fence/)
  })

  it('logs nothing when no owner is an error, whatever the other states', async () => {
    const owners = [NODE, { pid: 4, state: 'restricted' }, { pid: 5, state: 'gone' }, { pid: 0, state: 'gone' }, { pid: 6, state: 'reused' }]
    const { inspector: ports, logged } = inspector(line([v4(1, 4248), v4(2, 4), v4(3, 5), v4(4, 0), v4(5, 6)], owners))
    await ports.list()
    expect(logged).toEqual([])
  })

  it('logs the error owners once per listing, counted by Win32 code', async () => {
    const owners = [
      { pid: 7, state: 'error', code: 31 },
      { pid: 8, state: 'error', code: 31 },
      { pid: 9, state: 'error', code: 1_359 },
      NODE,
    ]
    // Two sockets of PID 7 are one owner entry, so one count.
    const { inspector: ports, logged } = inspector(line([v4(1, 7), v6(1, 7), v4(2, 8), v4(3, 9), v4(4, 4248)], owners))
    await ports.list()
    expect(logged).toEqual([{ level: 'warn', event: 'ports.owner-errors', detail: { '31': 2, '1359': 1 } }])
  })

  it('formats IPv4 and IPv6 addresses as on Linux, from network-order hex', async () => {
    const addresses: [string, string][] = [
      [v4(1, 4248, '00000000').address, '0.0.0.0'],
      [v4(1, 4248, 'c0a8000a').address, '192.168.0.10'],
      [v6(1, 4248, '0'.repeat(32)).address, '::'],
      [v6(1, 4248, '20010db8000000000000000000000005').address, '2001:db8::5'],
      [v6(1, 4248, '00000000000000000000ffff7f000001').address, '::ffff:127.0.0.1'],
      [v6(1, 4248, 'fe800000000000000a1b2c3d4e5f6071').address, 'fe80::a1b:2c3d:4e5f:6071'],
    ]
    const listeners = addresses.map(([hex], i) => (hex.length === 8 ? v4(i + 1, 4248, hex) : v6(i + 1, 4248, hex)))
    const snapshot = await inspector(line(listeners, [NODE])).inspector.list()
    expect(snapshot.ports.map((p) => p.address)).toEqual(addresses.map(([, text]) => text))
  })

  it('sorts by port, then family, then address, as on Linux', async () => {
    const listeners = [v6(80, 4248, '0'.repeat(32)), v4(443, 4248, '00000000'), v4(80, 4248, '7f000001'), v4(80, 4248, '00000000'), v6(22, 4248)]
    const snapshot = await inspector(line(listeners, [NODE])).inspector.list()
    expect(snapshot.ports.map((p) => `${p.port} ${p.family} ${p.address}`)).toEqual(['22 ipv6 ::1', '80 ipv4 0.0.0.0', '80 ipv4 127.0.0.1', '80 ipv6 ::', '443 ipv4 0.0.0.0'])
  })

  it('lists no ports when nothing listens', async () => {
    expect(await inspector(line([], [])).inspector.list()).toEqual({ takenAt: TAKEN_MS, ports: [] })
  })

  it('converts takenAt from FILETIME to Unix milliseconds exactly, rounding down', () => {
    expect(filetimeToUnixMs(TAKEN)).toBe(TAKEN_MS)
    expect(filetimeToUnixMs('116444736000000000')).toBe(0)
    expect(filetimeToUnixMs('116444735999999999')).toBeNull()
    expect(filetimeToUnixMs('1')).toBeNull()
    // The largest FILETIME is beyond a double's exact range, but its milliseconds are not.
    const largest = filetimeToUnixMs(String(0x7fff_ffff_ffff_ffffn))
    expect(largest).toBe(Number((0x7fff_ffff_ffff_ffffn - 116_444_736_000_000_000n) / 10_000n))
    expect(Number.isSafeInteger(largest)).toBe(true)
  })

  it('refuses anything but a canonical FILETIME decimal with a RangeError, not a SyntaxError', () => {
    for (const value of ['', '0', '0133485408000000000', '-1', '1e18', '0x1', ' 1', '1.5', 'abc', String(0x8000_0000_0000_0000n)]) {
      expect(() => filetimeToUnixMs(value), JSON.stringify(value)).toThrow(RangeError)
    }
  })

  it('refuses a listing taken before 1970', async () => {
    const error = await rejection(inspector(line([], [], '116444735999990000')).inspector.list())
    expect(error.message).toBe("The Windows helper's port listing was refused: it was taken before 1970 (116444735999990000)")
  })

  it('rejects a failed read with a plain Error naming the helper and the cause', async () => {
    const cause = new Error("The Windows helper's ports failed (exit code 1): GetExtendedTcpTable failed")
    const error = await rejection(inspector(() => Promise.reject(cause)).inspector.list())
    expect(error.constructor).toBe(Error)
    expect(error.message).toBe(`The Windows helper could not list the listening ports: ${cause.message}`)
    expect(error.cause).toBe(cause)
    // A thrown non-Error is described too.
    const throwsString = async (): Promise<string> => {
      await Promise.resolve()
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a reader that throws a non-Error must still be described
      throw 'gone'
    }
    expect((await rejection(inspector(throwsString).inspector.list())).message).toBe('The Windows helper could not list the listening ports: gone')
  })

  it.each([
    ['an empty output', ''],
    ['no final newline', line([], []).trimEnd()],
    ['two lines', `${line([], [])}${line([], [])}`],
    ['another message type', `${JSON.stringify({ type: 'inspected', processes: [] })}\n`],
    ['a listener without an owner entry', line([v4(1, 4248)], [])],
    ['an owner without a listener', line([], [NODE])],
    ['two entries for one PID', line([v4(1, 4248)], [NODE, NODE])],
    ['an unknown owner state', line([v4(1, 4248)], [{ pid: 4248, state: 'zombie' }])],
    ['an uppercase hex address', line([v4(1, 4248, '7F000001')], [NODE])],
    ['an extra field', line([{ ...v4(1, 4248), scope: 3 }], [NODE])],
  ])('rejects a malformed listing (%s) with a plain Error naming the helper', async (_what, output) => {
    const error = await rejection(inspector(output).inspector.list())
    expect(error.constructor).toBe(Error)
    expect(error.message).toMatch(/^The Windows helper's port listing was refused: /)
    expect(error.cause).toBeInstanceOf(ProtocolError)
  })

  it('refuses output over the ports limit without parsing it', async () => {
    const error = await rejection(inspector(`${' '.repeat(MAX_PORTS_OUTPUT_BYTES)}\n`).inspector.list())
    expect(error.message).toMatch(/^The Windows helper's port listing was refused: The ports output has \d+ bytes/)
    expect((error.cause as ProtocolError).kind).toBe('line-too-long')
  })
})
