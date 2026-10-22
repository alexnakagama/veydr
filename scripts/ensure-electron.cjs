'use strict'
// Electron fetches its binary lazily on first require. Resolve it before
// Playwright launches so the download never counts against a test timeout.
const { existsSync } = require('node:fs')

const binary = require('electron')
if (!existsSync(binary)) throw new Error(`Electron binary missing at ${binary}`)
console.log(`electron binary: ${binary}`)
