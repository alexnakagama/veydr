import { describe, it } from 'vitest'

// Windows port inspection through the real helper's `ports`, the supervisor and
// `createHelperPortsReader` (add-windows-port-inspection design D7). Group 4 implements these, and
// the standard-user cases get their own `[windows-only: Windows accounts]` suite then.

describe.runIf(process.platform === 'win32')('[windows-only: the helper\'s TCP tables]', () => {
  it.todo('[spec:port-inspection/command-port-shown-on-windows] attributes a command\'s and a grandchild\'s listeners to the command, with PID, name and creation time')
  it.todo('[spec:port-inspection/unmanaged-listener-on-windows] lists unmanaged listeners on 127.0.0.1 and ::1 with their PID and no command')
  it.todo('[spec:port-inspection/owner-hidden-from-a-standard-user-on-windows] shows a standard user the fixture\'s owner, and another listener\'s, as restricted')
  it.todo('[spec:port-inspection/windows-port-inspection-verified-natively] runs the helper\'s ports as a real standard user on the runner')
})
