// Records the environment it was started with, as a JSON array of [name, value] pairs in the order
// the environment block lists them, in the file named by VEYDR_RECORD_FILE, so a test can check
// which variables a started command sees (add-windows-environment-and-commands design D3).
//
//   VEYDR_RECORD_FILE=<file> node print-env.mjs [--marker <id>]
import { writeFileSync } from 'node:fs'

const file = process.env['VEYDR_RECORD_FILE']
if (file === undefined || file === '') {
  process.stderr.write('print-env: VEYDR_RECORD_FILE is not set\n')
  process.exit(2)
}
writeFileSync(file, JSON.stringify(Object.entries(process.env)), 'utf8')
