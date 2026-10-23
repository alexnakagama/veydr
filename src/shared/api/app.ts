import { z } from 'zod'

export const platformNames = ['linux', 'windows', 'unsupported'] as const
export type PlatformName = (typeof platformNames)[number]

export const appInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  platform: z.enum(platformNames),
  platformSupported: z.boolean(),
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
 * configuration (`src/main/config/store.ts`).
 */
export const noticeKinds = ['recovered-from-backup', 'reset-to-empty', 'newer-schema', 'preservation-failed', 'save-failed'] as const
export type NoticeKind = (typeof noticeKinds)[number]

export const noticeSeverities = ['info', 'warning', 'error'] as const
export type NoticeSeverity = (typeof noticeSeverities)[number]

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
})
export type Notice = z.infer<typeof noticeSchema>
