import { z } from 'zod'
import {
  absolutePathSchema,
  cwdSchema,
  envKeySchema,
  executionSchema,
  idSchema,
  nameSchema,
  stopTimeoutMsSchema,
  textSchema,
} from '../config/schema'

/**
 * An environment override as the renderer sees it. Secret values never leave the main process
 * except through `commands.revealSecret`; they are sent as `null` (design D2).
 */
export const envEntryViewSchema = z.discriminatedUnion('secret', [
  z.strictObject({ key: envKeySchema, secret: z.literal(false), value: textSchema }),
  z.strictObject({ key: envKeySchema, secret: z.literal(true), value: z.null() }),
])
export type EnvEntryView = z.infer<typeof envEntryViewSchema>

export const commandViewSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  execution: executionSchema,
  cwd: cwdSchema,
  env: z.array(envEntryViewSchema),
  stopTimeoutMs: stopTimeoutMsSchema,
})
export type CommandView = z.infer<typeof commandViewSchema>

export const projectViewSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  path: absolutePathSchema,
  commands: z.array(commandViewSchema),
})
export type ProjectView = z.infer<typeof projectViewSchema>

export const projectListSchema = z.array(projectViewSchema)

/** The chosen directory, or `null` when the picker was cancelled. */
export const pickDirectoryResponseSchema = absolutePathSchema.nullable()

export const projectRefSchema = z.strictObject({ projectId: idSchema })
export type ProjectRef = z.infer<typeof projectRefSchema>

export const addProjectRequestSchema = z.strictObject({ path: absolutePathSchema, name: nameSchema })
export type AddProjectRequest = z.infer<typeof addProjectRequestSchema>

export const updateProjectRequestSchema = z.strictObject({ projectId: idSchema, name: nameSchema })
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>

export const relocateProjectRequestSchema = z.strictObject({ projectId: idSchema, path: absolutePathSchema })
export type RelocateProjectRequest = z.infer<typeof relocateProjectRequestSchema>
