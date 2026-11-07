import { describe, it } from 'vitest'

// Windows commands through the resolver, the command lines and the real helper
// (add-windows-environment-and-commands designs D2, D4 and D5). Groups 3 to 5 implement these; the
// shim corpus and the plain batch file (group 2) are in windows-process-tree.test.ts, which keeps no
// `it.todo` of its own (workflow-policy.test.ts), and the editor test may move there too.

describe.skipIf(process.platform !== 'win32')('[windows-only: cmd.exe and PATHEXT]', () => {
  it.todo('[spec:project-registry/program-found-through-pathext] resolves npm to an npm.cmd on PATH and starts it')
  it.todo('[spec:project-registry/cmd-exe-script-runs] runs a cmd.exe script with && and %VARIABLE% and logs its result')
  it.todo('[spec:project-registry/batch-file-editor-on-windows] a .cmd editor receives a project path with spaces, & and ^ as one argument, with no new console window')
  it.todo('[spec:process-logs/console-output-on-windows] a cmd /c echo of non-ASCII text reaches the log unchanged')
})
