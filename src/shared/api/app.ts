import { z } from 'zod'
import { envNameRules } from '../config/env-names'

export const platformNames = ['linux', 'windows', 'unsupported'] as const
export type PlatformName = (typeof platformNames)[number]

export const appInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  platform: z.enum(platformNames),
  platformSupported: z.boolean(),
  /** Shell offered for new shell-mode commands; `null` when the user must enter one (design D5). */
  defaultShell: z.string().min(1).nullable(),
  /** How the platform compares environment variable names, for the editor's duplicate check. */
  envNames: z.enum(envNameRules),
  versions: z.strictObject({
    electron: z.string(),
    chrome: z.string(),
    node: z.string(),
  }),
})
export type AppInfo = z.infer<typeof appInfoSchema>

/** `app.getInfo` takes no payload. */
export const getInfoRequestSchema = z.undefined()

/**
 * What a notice is about. The configuration kinds mirror the notices returned by loading the
 * configuration (`src/main/config/store.ts`). The others:
 * - `crash-survivors`: processes Veydr started before it last ended abnormally are still running
 *   (listed in `processes`); the user resolves them with `processes.resolveSurvivors`;
 * - `ledger-problem`: the record of running commands could not be read, written, or checked, so
 *   such processes may go unnoticed;
 * - `quitting`: Veydr is stopping every running command before it exits;
 * - `environment`: the login shell environment could not be read, so commands get Veydr's own.
 */
export const noticeKinds = [
  'recovered-from-backup',
  'reset-to-empty',
  'newer-schema',
  'preservation-failed',
  'save-failed',
  'crash-survivors',
  'ledger-problem',
  'quitting',
  'environment',
] as const
export type NoticeKind = (typeof noticeKinds)[number]

export const noticeSeverities = ['info', 'warning', 'error'] as const
export type NoticeSeverity = (typeof noticeSeverities)[number]

/** A process a notice is about, with what the user needs to recognize it. */
export const noticeProcessSchema = z.strictObject({
  pid: z.int().min(1),
  name: z.string(),
  commandLine: z.string(),
})
export type NoticeProcess = z.infer<typeof noticeProcessSchema>

/**
 * Something the user must be told about (`app.onNotice`). Main keeps the notices of the current
 * session and sends all of them to every document that subscribes, so a reloaded window shows them
 * again; `id` lets the renderer drop repeats.
 */
export const noticeSchema = z.strictObject({
  id: z.string().min(1).max(64),
  kind: z.enum(noticeKinds),
  severity: z.enum(noticeSeverities),
  message: z.string().min(1),
  /** Files involved, e.g. where a damaged configuration file was kept. */
  files: z.array(z.string()),
  /** Processes involved, e.g. survivors of a crash. */
  processes: z.array(noticeProcessSchema).optional(),
})
export type Notice = z.infer<typeof noticeSchema>
