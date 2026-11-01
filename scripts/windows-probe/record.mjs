// The program behind the `fwd.cmd` shim of the `cmd-route-*` checks (task 5.1). It writes the
// arguments it received as JSON to veydr-record.json in its working directory, each case's own, for
// commands.mjs to compare with what the case intended. commands.mjs copies this file next to the
// shim, so it imports nothing, and names the file itself (RECORD_FILE).
import { writeFileSync } from 'node:fs'

writeFileSync('veydr-record.json', JSON.stringify(process.argv.slice(2)))
