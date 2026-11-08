// A minimal stand-in for the Veydr main process on Windows, bundled and run as its own process by
// test/integration/windows-commands.test.ts so that the test can end it with `taskkill /F`
// (add-windows-environment-and-commands design D4, task 4.3). As Veydr does, it first supervises a
// command through the real Windows process tree, so that libuv's job (kill on close) holds its
// helper, then launches an editor through `launchDetached`, as **Open in editor** does.
//
//   node editor-host.cjs < '<json EditorHostOptions>'
//
// The options come on stdin, not the command line, so that the environment in the plans does not
// show in process listings. Prints `launched` once both have started, then keeps running until it
// is ended.
import { createWindowsProcessTree } from '../../../src/main/platform/windows/process-tree'
import type { SpawnPlan } from '../../../src/main/platform/types'

export interface EditorHostOptions {
  readonly helperPath: string
  /** A long-running command the host supervises, as Veydr supervises a project's commands. */
  readonly supervised: SpawnPlan
  /** The editor. */
  readonly editor: SpawnPlan
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const options = JSON.parse(await readStdin()) as EditorHostOptions
  const tree = createWindowsProcessTree({ helperPath: options.helperPath })
  await tree.spawn(options.supervised)
  await tree.launchDetached(options.editor)
  process.stdout.write('launched\n')
  // Alive until the test ends it.
  setInterval(() => undefined, 1 << 30)
}

main().catch((error: unknown) => {
  process.stderr.write(`host failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
