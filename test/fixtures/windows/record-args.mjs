// Records the arguments it was started with, as a JSON array, in the file named by the
// VEYDR_RECORD_FILE environment variable, so a test can check what a program behind a command line
// or a batch-file shim received (add-windows-environment-and-commands design D1).
//
//   VEYDR_RECORD_FILE=<file> node record-args.mjs [<arg>...]
import { writeFileSync } from 'node:fs'

const file = process.env['VEYDR_RECORD_FILE']
if (file === undefined || file === '') {
  process.stderr.write('record-args: VEYDR_RECORD_FILE is not set\n')
  process.exit(2)
}
writeFileSync(file, JSON.stringify(process.argv.slice(2)), 'utf8')
