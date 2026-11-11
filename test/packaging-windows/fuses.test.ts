import { describe, it } from 'vitest'

// The fuses and the archive validation of the packaged Windows binary, `dist\win-unpacked\Veydr.exe`
// (add-windows-packaging design D3). Task 2.4 implements this file; the tag keeps
// `npm run spec-coverage` at zero unmapped scenarios until then.

describe.skipIf(process.platform !== 'win32')('[windows-only: the packaged Windows binary] fuses and archive validation', () => {
  it.todo('[spec:desktop-shell/modified-archive-refused-on-windows] refuses to start with an archive whose index was changed, and the replaced code does not run (task 2.4)')
})
