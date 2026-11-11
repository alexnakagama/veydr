// The name Veydr shows for a process this test suite started with `process.execPath` (Node).
import { basename } from 'node:path'

/**
 * The display name of the Node executable that runs the tests, and that the fixtures are started
 * with: the file name of `process.execPath`, as the host's path rules split it (`node` on Linux,
 * `node.exe` on Windows). It is what the Ports view shows for such a process on both systems: the
 * file name of its first argument on Linux, and of its image on Windows. No platform is read here.
 *
 * This holds because the fixtures are started with `process.execPath` itself. Were Node reached
 * through a shim that starts another executable (a version manager's `node.exe` redirect), the image
 * Windows reports would be that other file, and this name would no longer match.
 */
export function nodeDisplayName(): string {
  return basename(process.execPath)
}
