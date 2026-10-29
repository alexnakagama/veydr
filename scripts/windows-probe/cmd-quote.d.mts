// Types for scripts/windows-probe/cmd-quote.mjs.

export const MAX_COMMAND_LINE: number
export const SHIM_LINE_RESERVE: number
export function quoteArgument(arg: string): string
export function escapeForShim(text: string): string
export function cmdShimCommandLine(command: string, args: readonly string[]): string
export function cmdShimArgs(command: string, args: readonly string[]): string[]
