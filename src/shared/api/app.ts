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
