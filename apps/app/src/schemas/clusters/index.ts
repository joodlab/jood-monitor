import { z } from "zod";

export const idSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
export const workspaceSchema = z.strictObject({
  id: idSchema.refine(
    (id) => id !== "global",
    "global is reserved for the aggregate view"
  ),
  name: z.string().min(1).max(128),
});
export const clusterSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1).max(128),
  environment: z.string().max(64),
});
export const profileSchema = z.strictObject({
  name: z.enum(["basic", "standard", "diagnostic"]),
  returnProfile: z.enum(["basic", "standard", "diagnostic"]).optional(),
  revision: z.number().int().nonnegative().safe().default(0),
  appliedRevision: z.number().int().nonnegative().safe().default(0),
  expiresAt: z.string().datetime({ precision: null }).nullable().optional(),
  nodeUids: z
    .array(z.string().min(1).max(128))
    .max(5)
    .nullable()
    .default([])
    .transform((value) => value ?? []),
  namespaces: z
    .array(z.string().max(128))
    .max(32)
    .nullable()
    .default([])
    .transform((value) => value ?? []),
  paused: z.boolean().default(false),
});
export const enrollmentSchema = z.strictObject({ clusterId: idSchema });
export const snapshotSchema = z.strictObject({
  workspace: z.union([idSchema, z.literal("global")]),
  at: z.string().optional(),
});
export const historySchema = snapshotSchema.extend({
  cluster: idSchema,
  from: z.string(),
  to: z.string().optional(),
  entity: z.string().max(128).optional(),
  name: z.string().max(128).optional(),
});
// Metrics the hub accepts for one Node or Pod and a chart may read together.
// The agent never sends system.network.errors; container series stay with
// their pod.
export const seriesNames = [
  "system.cpu.time",
  "system.memory.usage",
  "system.memory.limit",
  "system.network.io",
  "system.disk.io",
  "system.filesystem.usage",
  "system.filesystem.inodes.usage",
  "k8s.node.cpu.usage",
  "k8s.node.memory.usage",
  "k8s.pod.cpu.usage",
  "k8s.pod.memory.usage",
] as const;
const distinct = (values: readonly string[]) =>
  new Set(values).size === values.length;
// Limits match SERIES_ENTITY_LIMIT and SERIES_NAME_LIMIT in
// lib/server/series-history.ts, which this client-shared schema cannot import.
export const seriesHistorySchema = z.strictObject({
  workspace: z.union([idSchema, z.literal("global")]),
  cluster: idSchema,
  from: z.string(),
  to: z.string().optional(),
  entities: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(20)
    .refine(distinct, "entities must be unique"),
  names: z
    .array(z.enum(seriesNames))
    .min(1)
    .max(9)
    .refine(distinct, "names must be unique"),
});
// The cluster Durable Object's history command. The singular fields are what
// an earlier Worker sends; the sets narrow one read to several series.
export const historyCommandSchema = z.strictObject({
  from: z.string(),
  to: z.string(),
  entity: z.string().max(128).optional(),
  name: z.string().max(128).optional(),
  entities: z.array(z.string().min(1).max(128)).max(20).optional(),
  names: z.array(z.string().min(1).max(128)).max(9).optional(),
});
export const clusterStatusSchema = z.strictObject({
  workspace: z.union([idSchema, z.literal("global")]),
  cluster: idSchema,
});
export const eventsSchema = snapshotSchema.extend({
  cluster: idSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export const recoveryExportSchema = z.strictObject({
  workspace: z.union([idSchema, z.literal("global")]),
  cluster: idSchema,
  cursor: z.string().max(128).optional(),
});
export const recoveryBatchExportSchema = recoveryExportSchema.extend({
  cursor: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  receivedSince: z.string().optional(),
});

export function defaultProfile() {
  return {
    name: "basic",
    revision: 1,
    appliedRevision: 0,
    nodeUids: [],
    namespaces: [],
    paused: false,
  } as const;
}
