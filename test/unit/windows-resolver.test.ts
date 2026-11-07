import { describe, it } from 'vitest'

// The Windows command resolver (add-windows-environment-and-commands design D2), unit-tested with a
// fake filesystem on every system. Group 3 implements these.

describe('Windows command resolver (design D2)', () => {
  it.todo('[spec:project-registry/working-directory-not-searched] never looks up a bare name in the working directory')
  it.todo('[spec:project-registry/unsupported-program-type-refused] refuses an extensionless npm found before npm.cmd, naming the file and the accepted types')
  it.todo('[spec:project-registry/drive-relative-program-path-refused] refuses C:tool.exe and \\tools\\tool.exe, asking for a full or working-directory-relative path')
  it.todo('[spec:project-registry/other-shell-refused-on-windows] refuses powershell.exe and bash.exe in shell mode, naming cmd.exe')
})
