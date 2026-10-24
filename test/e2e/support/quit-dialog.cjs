'use strict'
// Test-only: loaded with `-r`. Answers `dialog.showMessageBox` (the Retry / Quit anyway question
// on quit) without a native dialog: each call takes the next button label from
// VEYDR_TEST_DIALOG_ANSWERS (comma-separated) and appends what was asked to VEYDR_TEST_DIALOG_LOG.
const { appendFileSync } = require('node:fs')
const { dialog } = require('electron')

const answers = (process.env.VEYDR_TEST_DIALOG_ANSWERS ?? '').split(',').filter((a) => a !== '')
const logPath = process.env.VEYDR_TEST_DIALOG_LOG

dialog.showMessageBox = async (...args) => {
  const options = args.at(-1)
  const answer = answers.shift() ?? options.buttons[options.cancelId ?? 0]
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify({ message: options.message, detail: options.detail, buttons: options.buttons, answer })}\n`)
  return { response: options.buttons.indexOf(answer), checkboxChecked: false }
}
