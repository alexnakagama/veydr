'use strict'
// Test-only: loaded with `-r`. `dialog.showErrorBox` blocks on a native dialog, which would hang
// automated runs; print what it would have shown to stderr instead.
const { dialog } = require('electron')

dialog.showErrorBox = (title, content) => {
  process.stderr.write(`ERRORBOX ${title}: ${content}\n`)
}
