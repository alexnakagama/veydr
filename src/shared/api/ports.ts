import { z } from 'zod'
import { idSchema } from '../config/schema'

/**
 * Who holds a listening socket (design D12): a known process (with the command it is attributed to,
 * if any), `restricted` when the OS does not reveal the owner to this user, or `unknown`.
 */
export const portOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('known'), pid: z.int().min(1), name: z.string(), commandId: idSchema.nullable() }),
  z.strictObject({ kind: z.literal('restricted') }),
  z.strictObject({ kind: z.literal('unknown') }),
])
export type PortOwner = z.infer<typeof portOwnerSchema>

export const listeningPortSchema = z.strictObject({
  family: z.enum(['ipv4', 'ipv6']),
  address: z.string().min(1),
  port: z.int().min(0).max(65_535),
  owner: portOwnerSchema,
})
export type ListeningPort = z.infer<typeof listeningPortSchema>

export const portSnapshotSchema = z.strictObject({
  /** When the sockets were read, milliseconds since the Unix epoch. */
  refreshedAt: z.int().min(0),
  ports: z.array(listeningPortSchema),
})
export type PortSnapshot = z.infer<typeof portSnapshotSchema>
