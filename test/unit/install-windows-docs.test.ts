import { describe, it } from 'vitest'

// docs/install-windows.md, kept consistent with electron-builder.yml (add-windows-packaging design
// D9). Task 6.1 writes the page and implements this file; the tag keeps `npm run spec-coverage` at
// zero unmapped scenarios until then.

describe('Windows installation documentation', () => {
  it.todo('[spec:process-supervision/unsigned-installer-documented] states that the installer, the application and the helper are unsigned, the SmartScreen warning, and how to verify a download (task 6.1)')
})
