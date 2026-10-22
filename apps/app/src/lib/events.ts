import type { Entity, Lifecycle } from "@jood-monitor/api-client";
import { compactCpu, compactMemory } from "./infrastructure";

// Lifecycle rows keep the stored entity JSON in before/after. These helpers
// summarize them for people without changing what the evidence establishes:
// inventory diffs are observed, receipts are reported, and actors stay unknown.

export type EventCategory = "node" | "scaling" | "resources" | "automation";

interface EventChange {
  after: string;
  before: string;
  label: string;
}

export interface EventSummary {
  attribution: string;
  category: EventCategory;
  changes: EventChange[];
  // A ReplicaSet step of a Deployment rollout, not a scaling decision.
  rolloutStep: boolean;
  subject?: {
    kind: string;
    name: string;
    namespace?: string;
    uid?: string;
  };
  title: string;
  verb: string;
}

const receiptActions: Record<string, string> = {
  provisioning: "Provisioning reported",
  awaiting_join: "Awaiting node join",
  join_overdue: "Node join overdue",
  resize: "Resize reported",
  drain: "Drain reported",
  delete: "Deletion reported",
};

function parseEntity(value: string): Partial<Entity> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Partial<Entity>)
      : undefined;
  } catch {
    return;
  }
}

function parseReceipt(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return;
  }
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function change(
  label: string,
  before: unknown,
  after: unknown,
  format: (value?: number) => string
): EventChange | undefined {
  const old = number(before);
  const next = number(after);
  if (old === next) {
    return;
  }
  return { label, before: format(old), after: format(next) };
}

function replicas(value?: number) {
  return value == null ? "unknown" : String(value);
}

function subjectOf(entity?: Partial<Entity>) {
  if (!(entity?.kind && entity.name)) {
    return;
  }
  return {
    kind: entity.kind,
    name: entity.name,
    namespace: entity.namespace,
    uid: entity.uid,
  };
}

function qualified(subject?: EventSummary["subject"]) {
  if (!subject) {
    return "Unidentified resource";
  }
  return subject.namespace
    ? `${subject.kind} ${subject.namespace}/${subject.name}`
    : `${subject.kind} ${subject.name}`;
}

function attributionLabel(attribution: string) {
  if (attribution === "reported") {
    return "Reported by automation · not independently verified";
  }
  return "Observed in Kubernetes inventory · actor unknown";
}

function describeReceipt(event: Lifecycle, action: string): EventSummary {
  const evidence = parseReceipt(event.evidence);
  const server = text(evidence?.serverId);
  const node = text(evidence?.nodeUid);
  const changes =
    event.before || event.after
      ? [{ label: "State", before: event.before || "—", after: event.after }]
      : [];
  return {
    category: "automation",
    verb: receiptActions[action] ?? `Receipt: ${action.replaceAll("_", " ")}`,
    title: `${receiptActions[action] ?? action.replaceAll("_", " ")}${server ? ` · ${server}` : ""}`,
    subject: node
      ? { kind: "Node", name: server ?? node, uid: node }
      : undefined,
    changes,
    rolloutStep: false,
    attribution: attributionLabel(event.attribution),
  };
}

export function describeEvent(event: Lifecycle): EventSummary {
  if (event.kind.startsWith("receipt_")) {
    return describeReceipt(event, event.kind.slice("receipt_".length));
  }
  const before = parseEntity(event.before);
  const after = parseEntity(event.after);
  const subject = subjectOf(after) ?? subjectOf(before);
  const attribution = attributionLabel(event.attribution);
  if (event.kind === "node_join") {
    const capacity = [
      after?.capacityCpu == null ? undefined : compactCpu(after.capacityCpu),
      after?.capacityMemory == null
        ? undefined
        : compactMemory(after.capacityMemory),
    ].filter(Boolean);
    return {
      category: "node",
      verb: "Node joined",
      title: `Node ${subject?.name ?? "unknown"} joined${capacity.length ? ` (${capacity.join(", ")})` : ""}`,
      subject,
      changes: [],
      rolloutStep: false,
      attribution,
    };
  }
  if (event.kind === "node_removed") {
    return {
      category: "node",
      verb: "Node absent",
      title: `Node ${subject?.name ?? "unknown"} absent from Kubernetes`,
      subject,
      changes: [],
      rolloutStep: false,
      attribution: `${attribution} · provider deletion unconfirmed`,
    };
  }
  if (event.kind === "workload_horizontal") {
    const rolloutStep = subject?.kind === "ReplicaSet";
    return {
      category: "scaling",
      verb: rolloutStep ? "Rollout step" : "Replicas changed",
      title: `${qualified(subject)} replicas ${replicas(number(before?.desired))} → ${replicas(number(after?.desired))}`,
      subject,
      changes: [],
      rolloutStep,
      attribution,
    };
  }
  if (event.kind === "workload_vertical") {
    const changes = [
      change(
        "CPU request",
        before?.requestedCpu,
        after?.requestedCpu,
        compactCpu
      ),
      change("CPU limit", before?.limitedCpu, after?.limitedCpu, compactCpu),
      change(
        "Memory request",
        before?.requestedMemory,
        after?.requestedMemory,
        compactMemory
      ),
      change(
        "Memory limit",
        before?.limitedMemory,
        after?.limitedMemory,
        compactMemory
      ),
    ].filter((item): item is EventChange => !!item);
    return {
      category: "resources",
      verb: "Resources changed",
      title: `${qualified(subject)} resources changed`,
      subject,
      changes,
      rolloutStep: false,
      attribution,
    };
  }
  if (event.kind === "node_capacity") {
    const changes = [
      change(
        "CPU capacity",
        before?.capacityCpu,
        after?.capacityCpu,
        compactCpu
      ),
      change(
        "Memory capacity",
        before?.capacityMemory,
        after?.capacityMemory,
        compactMemory
      ),
    ].filter((item): item is EventChange => !!item);
    return {
      category: "node",
      verb: "Capacity changed",
      title: `Node ${subject?.name ?? "unknown"} capacity changed`,
      subject,
      changes,
      rolloutStep: false,
      attribution,
    };
  }
  return {
    category: "resources",
    verb: event.kind.replaceAll("_", " "),
    title: `${event.kind.replaceAll("_", " ")}${subject ? ` · ${qualified(subject)}` : ""}`,
    subject,
    changes: [],
    rolloutStep: false,
    attribution,
  };
}
