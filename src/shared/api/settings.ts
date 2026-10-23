import { z } from 'zod'
import { editorSchema, settingsSchema } from '../config/schema'

export { settingsSchema }

export const setEditorRequestSchema = z.strictObject({ editor: editorSchema.nullable() })
export type SetEditorRequest = z.infer<typeof setEditorRequestSchema>
