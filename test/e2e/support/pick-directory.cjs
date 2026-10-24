'use strict'
// Test-only: loaded with `-r`. Answers the native folder picker (`dialog.showOpenDialog`) without
// a native dialog: each call reads the path to return from VEYDR_TEST_PICK_FILE at that moment
// (an empty file means "cancelled"), so a test can change the answer between picks.
const { readFileSync } = require('node:fs')
const { dialog } = require('electron')

const answerFile = process.env.VEYDR_TEST_PICK_FILE

dialog.showOpenDialog = async () => {
  const answer = answerFile === undefined ? '' : readFileSync(answerFile, 'utf8')
  return answer === '' ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [answer] }
}
