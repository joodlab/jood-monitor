import type { Entity, Lifecycle } from "@jood-monitor/api-client";
import { compactCpu, compactMemory } from "./infrastructure";
import { knownTime } from "./time";

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
  // Every compared field that differs, led by the field whose difference
  // made the hub record the change.
  changes: EventChange[];
  // Inventory diffs are observed; automation receipts are reported.
  evidence: "observed" | "reported";
  // A ReplicaSet's own replica count, listed apart from workload scaling.
  replicaSetStep: boolean;
  subject?: {
    kind: string;
    name: string;
    namespace?: string;
    uid?: string;
  };
  // Creation time of a node the hub first observed well after it was
  // created, so rows can say how old it already was.
  subjectCreatedAt?: string;
  // What the event time measures, for its tooltip and screen-reader text.
  timeLabel: string;
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

// A node observed this long after its creation was already running when the
// hub first saw it, so "joined" would claim a time the hub did not observe.
const JOIN_WINDOW_MS = 15 * 60_000;

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

function replicas(value?: number) {
  return value == null ? "unknown" : String(value);
}

type ComparedField =
  | "desired"
  | "requestedCpu"
  | "limitedCpu"
  | "requestedMemory"
  | "limitedMemory"
  | "capacityCpu"
  | "capacityMemory";

const comparedFields: {
  field: ComparedField;
  format: (value?: number) => string;
  label: string;
}[] = [
  { field: "desired", label: "Replicas (desired)", format: replicas },
  { field: "requestedCpu", label: "CPU request", format: compactCpu },
  { field: "limitedCpu", label: "CPU limit", format: compactCpu },
  { field: "requestedMemory", label: "Memory request", format: compactMemory },
  { field: "limitedMemory", label: "Memory limit", format: compactMemory },
  { field: "capacityCpu", label: "CPU capacity", format: compactCpu },
  { field: "capacityMemory", label: "Memory capacity", format: compactMemory },
];

// The fields whose difference made the cluster state record each kind, in
// the order it compares them.
const triggers: Record<string, ComparedField[]> = {
  workload_horizontal: ["desired"],
  node_capacity: ["capacityCpu", "capacityMemory"],
  workload_vertical: [
    "requestedCpu",
    "limitedCpu",
    "requestedMemory",
    "limitedMemory",
  ],
};

// Every compared field that differs between the stored before and after
// entities, the triggering fields first.
function fieldChanges(
  kind: string,
  before?: Partial<Entity>,
  after?: Partial<Entity>
): EventChange[] {
  const first = triggers[kind] ?? [];
  const ordered = [
    ...comparedFields.filter((item) => first.includes(item.field)),
    ...comparedFields.filter((item) => !first.includes(item.field)),
  ];
  const changes: EventChange[] = [];
  for (const { field, label, format } of ordered) {
    const old = number(before?.[field]);
    const next = number(after?.[field]);
    if (old !== next) {
      changes.push({ label, before: format(old), after: format(next) });
    }
  }
  return changes;
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

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function attributionLabel(attribution: string) {
  if (attribution === "reported") {
    return "Reported by automation · not independently verified";
  }
  return "Observed in Kubernetes inventory · actor unknown";
}

// The stored attribution, not the kind's receipt_ prefix, says whether the
// row was observed or reported.
function evidenceOf(event: Lifecycle): EventSummary["evidence"] {
  return event.attribution === "reported" ? "reported" : "observed";
}

// What the event time measures. Reported receipts carry the automation's
// own time; inventory diffs carry the source time of the first inventory
// that showed the change (or the absence).
function timeLabelOf(event: Lifecycle) {
  if (event.attribution === "reported") {
    return "Reported time";
  }
  return event.kind === "node_removed"
    ? "First observed absent from inventory"
    : "First observed in inventory";
}

// The parts of a summary that depend on the kind of change.
type Described = Pick<EventSummary, "category" | "title" | "verb"> &
  Partial<Pick<EventSummary, "replicaSetStep" | "subjectCreatedAt">>;

interface Parsed {
  after?: Partial<Entity>;
  before?: Partial<Entity>;
  event: Lifecycle;
  subject?: EventSummary["subject"];
}

function capacityText(after?: Partial<Entity>) {
  const capacity = [
    after?.capacityCpu == null ? undefined : compactCpu(after.capacityCpu),
    after?.capacityMemory == null
      ? undefined
      : compactMemory(after.capacityMemory),
  ].filter(Boolean);
  return capacity.length ? ` (${capacity.join(", ")})` : "";
}

// Joined only when the node was created shortly before the hub first saw
// it; otherwise, or without a readable creation time, first observed.
function joinedRecently({ event, after }: Parsed) {
  const created = knownTime(after?.createdAt);
  const observed = knownTime(event.observedAt);
  return (
    created != null && observed != null && observed - created <= JOIN_WINDOW_MS
  );
}

function describeJoin(parsed: Parsed): Described {
  const name = parsed.subject?.name ?? "unknown";
  const capacity = capacityText(parsed.after);
  if (joinedRecently(parsed)) {
    return {
      category: "node",
      verb: "Node joined",
      title: `Node ${name} joined${capacity}`,
    };
  }
  const created = parsed.after?.createdAt ?? undefined;
  return {
    category: "node",
    verb: "Node first observed",
    title: `Node ${name} first observed in inventory${capacity}`,
    subjectCreatedAt: knownTime(created) == null ? undefined : created,
  };
}

function describeHorizontal({ subject, before, after }: Parsed): Described {
  const replicaSetStep = subject?.kind === "ReplicaSet";
  return {
    category: "scaling",
    verb: replicaSetStep ? "ReplicaSet replicas changed" : "Replicas changed",
    title: `${qualified(subject)} replicas ${replicas(number(before?.desired))} → ${replicas(number(after?.desired))}`,
    replicaSetStep,
  };
}

const templateKinds = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
]);

// Workloads carry their pod template's requests and limits; a Pod its own.
function verticalAction(kind?: string) {
  if (kind && templateKinds.has(kind)) {
    return "pod template requests/limits changed";
  }
  return kind === "Pod"
    ? "pod requests/limits changed"
    : "requests/limits changed";
}

function describeVertical({ subject }: Parsed): Described {
  const action = verticalAction(subject?.kind);
  return {
    category: "resources",
    verb: capitalize(action),
    title: `${qualified(subject)} ${action}`,
  };
}

const describers: Record<string, (parsed: Parsed) => Described> = {
  node_join: describeJoin,
  node_removed: ({ subject }) => ({
    category: "node",
    verb: "Node absent",
    title: `Node ${subject?.name ?? "unknown"} absent from Kubernetes`,
  }),
  workload_horizontal: describeHorizontal,
  workload_vertical: describeVertical,
  node_capacity: ({ subject }) => ({
    category: "node",
    verb: "Capacity changed",
    title: `Node ${subject?.name ?? "unknown"} capacity changed`,
  }),
};

// Receipts name the provider server, matched to the Kubernetes node the
// automation reported, so the row still finds and opens that node.
function describeReceipt(event: Lifecycle, action: string): EventSummary {
  const receipt = parseReceipt(event.evidence);
  const server = text(receipt?.serverId);
  const node = text(receipt?.nodeUid);
  const name = server ?? node;
  const changes =
    event.before || event.after
      ? [{ label: "State", before: event.before || "—", after: event.after }]
      : [];
  return {
    category: "automation",
    verb: receiptActions[action] ?? `Receipt: ${action.replaceAll("_", " ")}`,
    title: `${receiptActions[action] ?? action.replaceAll("_", " ")}${server ? ` · ${server}` : ""}`,
    subject: name ? { kind: "Server", name, uid: node } : undefined,
    changes,
    evidence: evidenceOf(event),
    replicaSetStep: false,
    timeLabel: timeLabelOf(event),
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
  const label = event.kind.replaceAll("_", " ");
  const described: Described = describers[event.kind]?.({
    event,
    before,
    after,
    subject,
  }) ?? {
    category: "resources",
    verb: label,
    title: `${label}${subject ? ` · ${qualified(subject)}` : ""}`,
  };
  return {
    ...described,
    subject,
    changes: triggers[event.kind]
      ? fieldChanges(event.kind, before, after)
      : [],
    evidence: evidenceOf(event),
    replicaSetStep: described.replicaSetStep ?? false,
    timeLabel: timeLabelOf(event),
    attribution:
      event.kind === "node_removed"
        ? `${attribution} · provider deletion unconfirmed`
        : attribution,
  };
}
