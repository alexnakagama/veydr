// Types for scripts/windows-probe/encoding.mjs.
import type { ProgramResult, RunDriverOptions } from './driver.mjs'
import type { AnswerDetail } from './process-tree.mjs'

export interface CodePages {
  acp: number
  oemcp: number
  consoleOutputCP: number
}

export function asciiLiteral(text: string): string
export function encodingCommand(
  tool: string,
  variant: string,
  input: { text: string; node: string; cmd: string; env: Readonly<Record<string, string | undefined>> },
): { file: string; args: string[]; options: { windowsVerbatimArguments?: boolean; env?: Record<string, string | undefined> } }
export function encodingAnswer(input: { run: ProgramResult; bytes: Uint8Array; expected: string }): AnswerDetail
export function parseCodePages(stdout: string): CodePages | undefined
export function codePagesAnswer(input: { hidden: CodePages | undefined; run: ProgramResult }): AnswerDetail

export function runEncoding(args: readonly string[], options?: Partial<RunDriverOptions>): Promise<void>
