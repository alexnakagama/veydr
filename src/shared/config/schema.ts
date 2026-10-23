import { z } from 'zod'

/** Schema version written by this build. Older versions are migrated on load (see `src/main/config/migrations.ts`). */
export const CURRENT_SCHEMA_VERSION = 1

/** Default grace period before a stop is forced (spec: process-supervision, graceful then forced stop). */
export const DEFAULT_STOP_TIMEOUT_MS = 5_000
export const MAX_STOP_TIMEOUT_MS = 300_000

/** Placeholder in an editor argument template that is replaced by the project path. */
export const EDITOR_PATH_PLACEHOLDER = '{path}'

const MAX_NAME_LENGTH = 200

// NUL cannot appear in a path, argument, or environment entry passed to the OS.
const noNul = (value: string): boolean => !value.includes('\0')

/**
 * Absolute in the platform-neutral sense: POSIX (`/…`), Windows drive (`C:\…`, `C:/…`), or UNC (`\\…`).
 * Shared code runs in the renderer too, so `node:path` is not available here; the main process
 * resolves and verifies real paths before using them.
 */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * Comparison key for project paths: trailing separators removed, so `/a/b` and `/a/b/`
 * count as the same directory. Not a full normalization: the main process stores real
 * paths (resolved symlinks, no `.`/`..`) when registering projects.
 */
export function projectPathKey(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  // Keep a root (`/`, `C:\`, `\\`) recognisable as such.
  if (trimmed === '' || /^[A-Za-z]:$/.test(trimmed)) return path
  return trimmed
}

// Field schemas are exported so IPC payloads (src/shared/api) validate exactly like stored configuration.
export const textSchema = z.string().refine(noNul, { message: 'Must not contain NUL characters' })
export const nonEmptyTextSchema = textSchema.refine((value) => value.length > 0, { message: 'Must not be empty' })
export const absolutePathSchema = nonEmptyTextSchema.refine(isAbsolutePath, { message: 'Must be an absolute path' })

export const nameSchema = z
  .string()
  .max(MAX_NAME_LENGTH, { message: `Must be at most ${MAX_NAME_LENGTH} characters` })
  .refine((value) => value.trim().length > 0, { message: 'Must not be empty' })
  .refine(noNul, { message: 'Must not contain NUL characters' })

export const idSchema = z.uuid({ message: 'Must be a UUID' })

export const envKeySchema = nonEmptyTextSchema.refine((value) => !value.includes('='), { message: 'Must not contain "="' })

/** Working directory relative to the project root; containment is verified when starting. */
export const cwdSchema = nonEmptyTextSchema.refine((value) => !isAbsolutePath(value), {
  message: 'Must be relative to the project root',
})

export const stopTimeoutMsSchema = z
  .int({ message: 'Must be a whole number of milliseconds' })
  .min(0, { message: 'Must not be negative' })
  .max(MAX_STOP_TIMEOUT_MS, { message: `Must be at most ${MAX_STOP_TIMEOUT_MS} ms` })

export const envEntrySchema = z.strictObject({
  key: envKeySchema,
  value: textSchema,
  /** Masked in the UI and redacted from logs. Stored in plaintext (see docs/configuration.md). */
  secret: z.boolean(),
})

const directSchema = z.strictObject({
  mode: z.literal('direct'),
  /** Executable name (looked up on `PATH`) or path; never interpreted by a shell. */
  file: nonEmptyTextSchema,
  args: z.array(textSchema),
})

const shellSchema = z.strictObject({
  mode: z.literal('shell'),
  /** Absolute path of the shell that interprets `script` (`<shell> -c <script>`). */
  shell: absolutePathSchema,
  script: nonEmptyTextSchema,
})

export const executionSchema = z.discriminatedUnion('mode', [directSchema, shellSchema])

export const commandSchema = z
  .strictObject({
    id: idSchema,
    name: nameSchema,
    execution: executionSchema,
    cwd: cwdSchema,
    env: z.array(envEntrySchema),
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

export const projectSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  /** Absolute path of the project root as registered (resolved with realpath by the main process). */
  path: absolutePathSchema,
  commands: z.array(commandSchema),
})

export const editorSchema = z
  .strictObject({
    file: nonEmptyTextSchema,
    args: z.array(textSchema),
  })
  .refine((editor) => editor.args.some((arg) => arg.includes(EDITOR_PATH_PLACEHOLDER)), {
    message: `One argument must contain ${EDITOR_PATH_PLACEHOLDER}`,
    path: ['args'],
  })

export const settingsSchema = z.strictObject({
  editor: editorSchema.nullable(),
})

export const configSchema = z
  .strictObject({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    projects: z.array(projectSchema),
    settings: settingsSchema,
  })
  .superRefine((config, ctx) => {
    const projectIds = new Set<string>()
    const paths = new Set<string>()
    const commandIds = new Set<string>()
    config.projects.forEach((project, p) => {
      if (projectIds.has(project.id)) {
        ctx.addIssue({ code: 'custom', path: ['projects', p, 'id'], message: 'Duplicate project id' })
      }
      projectIds.add(project.id)
      const key = projectPathKey(project.path)
      if (paths.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['projects', p, 'path'], message: 'Directory is already registered' })
      }
      paths.add(key)
      project.commands.forEach((command, c) => {
        if (commandIds.has(command.id)) {
          ctx.addIssue({ code: 'custom', path: ['projects', p, 'commands', c, 'id'], message: 'Duplicate command id' })
        }
        commandIds.add(command.id)
      })
    })
  })

export type EnvEntry = z.infer<typeof envEntrySchema>
export type Execution = z.infer<typeof executionSchema>
export type CommandConfig = z.infer<typeof commandSchema>
export type ProjectConfig = z.infer<typeof projectSchema>
export type EditorConfig = z.infer<typeof editorSchema>
export type Settings = z.infer<typeof settingsSchema>
export type Config = z.infer<typeof configSchema>

export function emptyConfig(): Config {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, projects: [], settings: { editor: null } }
}

export interface ConfigIssue {
  /** Dotted field path, e.g. `projects[0].commands[1].name`; empty for the document root. */
  readonly path: string
  readonly message: string
}

export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => {
    if (typeof key === 'number') return `${out}[${key}]`
    return out === '' ? String(key) : `${out}.${String(key)}`
  }, '')
}

export type ConfigValidation = { readonly ok: true; readonly config: Config } | { readonly ok: false; readonly issues: readonly ConfigIssue[] }

/** Validates a complete configuration document against the current schema. */
export function validateConfig(input: unknown): ConfigValidation {
  const parsed = configSchema.safeParse(input)
  if (parsed.success) return { ok: true, config: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message })),
  }
}
