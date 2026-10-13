import { z } from "zod";
import { clusterSchema, profileSchema, workspaceSchema } from "../clusters";
import { heartbeatSchema, inventorySchema } from "../telemetry";

const verifier = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
export const registryImportSchema = z.strictObject({
  workspaces: z.array(workspaceSchema).max(64),
  clusters: z
    .array(
      clusterSchema.extend({
        credentialHash: verifier,
        enrollmentHash: verifier,
        enrollmentExpiry: z.string().datetime({ precision: null }).nullable(),
        revoked: z.boolean(),
        profile: profileSchema,
      })
    )
    .max(256),
});
export const observationImportSchema = z.strictObject({
  inventory: inventorySchema,
  heartbeat: heartbeatSchema,
  profile: profileSchema,
  times: z.strictObject({
    inventoryTime: z.string().nullable(),
    receivedAt: z.string().nullable(),
    heartbeatAt: z.string().nullable(),
  }),
});

export const historicalObservationSchema = observationImportSchema.extend({
  profile: profileSchema.nullable(),
  heartbeat: heartbeatSchema.nullable(),
  observationId: z.string().min(1).max(128),
});

export const inventoryReceiptSchema = z.strictObject({
  id: z.string().regex(/^\d{1,20}$/),
  sourceTime: z.string(),
  contentId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

const exactInteger = z.string().regex(/^-?\d{1,20}$/);
export const storedMetricSchema = z.strictObject({
  id: z.number().int().nonnegative().safe(),
  clusterId: z.string().min(1).max(64),
  entityUid: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  unit: z.string().max(32),
  kind: z.enum(["gauge", "sum"]),
  temporality: z.number().int().min(0).max(2),
  monotonic: z.boolean(),
  integer: z.boolean(),
  value: z.string().max(64),
  timeUnixNano: exactInteger,
  startTimeUnixNano: exactInteger,
  sourceTime: z.string(),
  receivedAt: z.string(),
  diagnostic: z.boolean(),
  resource: z.string().max(8192),
  scope: z.string().max(8192),
  attributes: z.string().max(8192),
});
const lifecycle = z.strictObject({
  id: z.string().min(1).max(128),
  clusterId: z.string().min(1).max(64),
  kind: z.string().max(64),
  before: z.string().max(65_536),
  after: z.string().max(65_536),
  evidence: z.string().max(65_536),
  attribution: z.string().max(64),
  observedAt: z.string(),
  receivedAt: z.string(),
});
export const historyImportSchema = z.strictObject({
  batchId: z.string().regex(/^[a-f0-9]{64}$/),
  metrics: z.array(storedMetricSchema).max(5000).default([]),
  events: z.array(lifecycle).max(1000).default([]),
  observations: z
    .array(
      observationImportSchema.extend({
        observationId: z.string().min(1).max(128),
      })
    )
    .max(20)
    .default([]),
});

export const archiveImportSchema = z.strictObject({
  kind: z.enum([
    "raw",
    "diagnostic",
    "inventory",
    "inventory-content",
    "inventory-receipts",
    "legacy-rollups",
    "legacy-changes",
    "legacy-dirty",
  ]),
  entityUid: z.string().max(128),
  sourceStart: z.string(),
  sourceEnd: z.string(),
  expiresAt: z.string().datetime({ precision: null }),
  points: z.number().int().nonnegative().safe(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.unknown(),
});
