import { z } from "zod";

const text = z.string().max(256);
const time = z.string().datetime({ precision: null });
const quantity = z.number().finite().nonnegative().optional();
const count = z.number().int().nonnegative().safe();
const capabilities = z
  .array(text)
  .max(32)
  .nullable()
  .transform((value) => value ?? []);
const entity = z.strictObject({
  uid: z.string().min(1).max(128),
  kind: text,
  name: text,
  status: z.string().max(128),
  namespace: z.string().max(128).optional(),
  nodeUid: z.string().max(128).optional(),
  providerId: text.optional(),
  createdAt: time.nullable().optional(),
  addresses: z.array(text).max(32).optional(),
  roles: z.array(text).max(32).optional(),
  region: text.optional(),
  zone: text.optional(),
  os: text.optional(),
  kernel: text.optional(),
  kubeletVersion: text.optional(),
  serviceType: text.optional(),
  ports: z
    .array(
      z.strictObject({
        name: text.optional(),
        port: z.number().int().nonnegative(),
        protocol: text,
      })
    )
    .max(100)
    .optional(),
  hosts: z.array(text).max(100).optional(),
  conditions: z
    .array(
      z.strictObject({ type: text, status: text, reason: text.optional() })
    )
    .max(64)
    .optional(),
  capacityCpu: quantity,
  allocatableCpu: quantity,
  capacityMemory: quantity,
  allocatableMemory: quantity,
  requestedCpu: quantity,
  limitedCpu: quantity,
  requestedMemory: quantity,
  limitedMemory: quantity,
  desired: count.optional(),
  ready: count.optional(),
  restarts: count.optional(),
  containers: z
    .array(
      z.strictObject({
        name: text,
        init: z.boolean(),
        appliedCpu: quantity,
        appliedMemory: quantity,
        allocatedCpu: quantity,
        allocatedMemory: quantity,
      })
    )
    .max(128)
    .optional(),
  resizeConditions: z
    .array(
      z.strictObject({
        type: text,
        status: text,
        reason: text.optional(),
        transitionTime: time,
      })
    )
    .max(64)
    .optional(),
});

export const inventorySchema = z.strictObject({
  sourceTime: time,
  entities: z.array(entity).max(10_000),
  edges: z
    .array(
      z.strictObject({
        source: z.string().max(128),
        target: z.string().max(128),
        relation: text,
        evidence: z.string().max(512),
      })
    )
    .max(20_000)
    .nullable()
    .transform((value) => value ?? []),
  capabilities,
});

export const heartbeatSchema = z.strictObject({
  version: z.string().max(128),
  appliedRevision: count,
  queueBytes: count,
  dropped: count,
  rejectedPoints: count,
  capabilities,
  outcome: z.string().max(256),
  nodes: z
    .array(
      z.strictObject({
        nodeUid: z.string().min(1).max(128),
        seenAt: time,
        appliedRevision: count,
        profile: z.enum(["basic", "standard", "diagnostic"]),
        paused: z.boolean(),
        dropped: count,
      })
    )
    .max(4096)
    .nullable()
    .transform((value) => value ?? [])
    .optional(),
});

export const receiptSchema = z.strictObject({
  id: z.string().min(1).max(128),
  action: z.enum([
    "provisioning",
    "awaiting_join",
    "join_overdue",
    "resize",
    "drain",
    "delete",
  ]),
  serverId: z.string().max(128),
  nodeUid: z.string().max(128).optional(),
  before: text,
  after: text,
  observedAt: time,
  correlationId: z.string().max(128),
});
