import { BaseSequencer, type TestSpecification } from 'vitest/node'

// The order of the test files (vitest's `sequence.sequencer`, set for the whole run). vitest's own
// order is kept, with one exception: the standard user's installation of the `packaging-windows`
// project runs after every other file of the run. Its smoke step may be "not testable" only if the same
// installer's smoke test passed for the administrator in the same run (add-windows-packaging design
// D5), which installer.test.ts records; vitest otherwise orders files by earlier durations or size.
// Order alone is not enough: the project also sets `fileParallelism: false` (vitest.config.ts), so
// installer.test.ts has finished before this file starts. The two rely on each other, and a unit
// test (packaging-windows-support.test.ts) pins both.

/** Files that run last within their project, by project name. */
export const RUN_LAST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'packaging-windows': Object.freeze(['standard-user-install.test.ts']),
})

const runsLast = (projectName: string, moduleId: string): boolean => (RUN_LAST[projectName] ?? []).some((name) => moduleId.replace(/\\/g, '/').endsWith(`/${name}`))

/** `files` in their given order, but with the RUN_LAST files moved to the end, in their given order. */
export function runLastOrder<T extends { readonly moduleId: string; readonly project: { readonly name: string } }>(files: readonly T[]): T[] {
  const last = files.filter((f) => runsLast(f.project.name, f.moduleId))
  return [...files.filter((f) => !last.includes(f)), ...last]
}

export default class Sequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return runLastOrder(await super.sort(files))
  }
}
