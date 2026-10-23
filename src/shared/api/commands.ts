import { z } from 'zod'
import {
  cwdSchema,
  envKeySchema,
  executionSchema,
  idSchema,
  nameSchema,
  stopTimeoutMsSchema,
  textSchema,
} from '../config/schema'

/**
 * An environment override sent by the command editor. `value: null` keeps the stored value of an
 * existing secret, which the renderer never received; it is only valid for secret entries.
 */
export const envEntryInputSchema = z
  .strictObject({ key: envKeySchema, secret: z.boolean(), value: textSchema.nullable() })
  .refine((entry) => entry.value !== null || entry.secret, {
    message: 'Only a secret value may be left unchanged',
    path: ['value'],
  })
export type EnvEntryInput = z.infer<typeof envEntryInputSchema>

export const commandInputSchema = z
  .strictObject({
    /** `null` adds a new command; otherwise the command to replace. */
    id: idSchema.nullable(),
    name: nameSchema,
    execution: executionSchema,
    cwd: cwdSchema,
    env: z.array(envEntryInputSchema),
    stopTimeoutMs: stopTimeoutMsSchema,
  })
  .superRefine((command, ctx) => {
    const seen = new Set<string>()
    command.env.forEach((entry, index) => {
      if (seen.has(entry.key)) {
        ctx.addIssue({ code: 'custom', path: ['env', index, 'key'], message: `Duplicate variable "${entry.key}"` })
      }
      seen.add(entry.key)
    })
  })
export type CommandInput = z.infer<typeof commandInputSchema>

export const upsertCommandRequestSchema = z.strictObject({ projectId: idSchema, command: commandInputSchema })
export type UpsertCommandRequest = z.infer<typeof upsertCommandRequestSchema>

export const commandRefSchema = z.strictObject({ commandId: idSchema })
export type CommandRef = z.infer<typeof commandRefSchema>

export const environmentSources = ['base', 'override'] as const

/** One variable of a command's effective environment; secret values are masked (`null`). */
export const environmentEntrySchema = z.discriminatedUnion('secret', [
  z.strictObject({ key: z.string().min(1), secret: z.literal(false), value: z.string(), source: z.enum(environmentSources) }),
  z.strictObject({ key: z.string().min(1), secret: z.literal(true), value: z.null(), source: z.literal('override') }),
])
export type EnvironmentEntry = z.infer<typeof environmentEntrySchema>

export const environmentPreviewSchema = z.strictObject({
  entries: z.array(environmentEntrySchema),
  /** E.g. that the login shell could not be resolved and the inherited environment is used. */
  warnings: z.array(z.string()),
})
export type EnvironmentPreview = z.infer<typeof environmentPreviewSchema>

export const revealSecretRequestSchema = z.strictObject({ commandId: idSchema, key: envKeySchema })
export type RevealSecretRequest = z.infer<typeof revealSecretRequestSchema>

export const revealedSecretSchema = z.strictObject({ value: textSchema })
