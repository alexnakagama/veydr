import { describe, it } from 'vitest'

// What `npm run dist:windows` puts in `dist\` and in the unpacked build (add-windows-packaging design
// D3). Task 2.3 implements this file; the tags keep `npm run spec-coverage` at zero unmapped
// scenarios until then.

describe.skipIf(process.platform !== 'win32')('[windows-only: the Windows package] package contents', () => {
  it.todo('[spec:desktop-shell/no-update-metadata] builds no .blockmap, latest.yml or app-update.yml, and the installed application holds none (task 2.3)')
  it.todo('[spec:desktop-shell/helper-outside-the-archive] places the helper beside app.asar, and the archive holds no .exe, .dll or .node (task 2.3)')
})
