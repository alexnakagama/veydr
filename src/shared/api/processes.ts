import { z } from 'zod'
import { idSchema } from '../config/schema'

export const processStatuses = ['idle', 'starting', 'running', 'stopping', 'exited', 'failed'] as const
export type ProcessStatus = (typeof processStatuses)[number]

/** Identifies one run (one start) of a command. */
export const runIdSchema = z.uuid({ message: 'Must be a UUID' })

const pidSchema = z.int().min(1)
/** Milliseconds since the Unix epoch. */
const epochMsSchema = z.int().min(0)

/**
 * Envelope carried by every event about a run (design D7). `seq` increases with every event of
 * its kind for the command: state events count per command across runs (so a renderer can tell a
 * snapshot from newer events), log batches per run. Consumers drop events whose `runId` is not the
 * command's current run (spec: late events ignored).
 */
export const eventEnvelopeSchema = z.strictObject({
  commandId: idSchema,
  runId: runIdSchema,
  seq: z.int().min(1),
})
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>

export const exitInfoSchema = z.strictObject({
  code: z.int().nullable(),
  signal: z.string().min(1).nullable(),
  /** Whether Veydr had to force termination after the stop timeout. */
  forced: z.boolean(),
})
export type ExitInfo = z.infer<typeof exitInfoSchema>

export const processInfoSchema = z.strictObject({ pid: pidSchema, name: z.string() })
export type ProcessInfo = z.infer<typeof processInfoSchema>

const runStateShape = {
  status: z.enum(processStatuses),
  /** PID of the run's leader while it is known. */
  pid: pidSchema.nullable(),
  startedAt: epochMsSchema.nullable(),
  exit: exitInfoSchema.nullable(),
  /** Human-readable reason for `failed`. */
  error: z.string().nullable(),
  /** Attributed processes still alive after the last stop (spec: survivors reported). */
  survivors: z.array(processInfoSchema),
}

/** The part of a command's process state the supervisor sets; the envelope is added by main. */
export const runStateSchema = z.strictObject(runStateShape)
export type RunState = z.infer<typeof runStateSchema>

/** `processes.onState` payload. The first event of every run has status `starting`. */
export const processStateEventSchema = eventEnvelopeSchema.extend(runStateShape)
export type ProcessStateEvent = z.infer<typeof processStateEventSchema>

/**
 * A command's state in `processes.snapshot`. A command that has not run in this session has
 * `runId: null`, `seq: 0`, and status `idle`; otherwise `seq` is that of the last state event.
 */
export const commandProcessStateSchema = z.strictObject({
  commandId: idSchema,
  runId: runIdSchema.nullable(),
  seq: z.int().min(0),
  ...runStateShape,
})
export type CommandProcessState = z.infer<typeof commandProcessStateSchema>

export const processSnapshotSchema = z.strictObject({ commands: z.array(commandProcessStateSchema) })
export type ProcessSnapshot = z.infer<typeof processSnapshotSchema>

/** Survivors found after a crash are terminated only on the user's explicit `terminate`. */
export const resolveSurvivorsRequestSchema = z.strictObject({ action: z.enum(['terminate', 'dismiss']) })
export type ResolveSurvivorsRequest = z.infer<typeof resolveSurvivorsRequestSchema>

export const resolveSurvivorsResponseSchema = z.strictObject({ remaining: z.array(processInfoSchema) })
export type ResolveSurvivorsResponse = z.infer<typeof resolveSurvivorsResponseSchema>
