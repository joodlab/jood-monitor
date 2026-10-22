import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  freshness,
  inventoryFreshness,
  nodeProfileOutcome,
} from "../lib/metrics";

// Pure collection-settings logic: drafts, change summaries, validation and
// acknowledgment progress. The hub's profile stays the source of truth.

export const profileNames = ["basic", "standard", "diagnostic"] as const;
export type ProfileName = (typeof profileNames)[number];

export const profileChoices: Record<
  ProfileName,
  { label: string; detail: string }
> = {
  basic: {
    label: "Basic",
    detail:
      "Node resources every 60s. Inventory and pod status through API reconciliation.",
  },
  standard: {
    label: "Standard",
    detail:
      "Node, pod and container CPU/memory every 30s when Metrics API is available. Host counters every 60s.",
  },
  diagnostic: {
    label: "Diagnostic",
    detail:
      "Selected host sources every 5s on one node, bounded in time. Upstream pod Metrics API resolution stays unchanged.",
  },
};

// The hub accepts diagnostics that expire within 10 minutes.
export const diagnosticMinutes = 9;
export const namespaceLimit = 32;
const namespaceMaxLength = 128;
const whitespace = /\s/;

function asProfileName(value: string | undefined): ProfileName {
  return profileNames.includes(value as ProfileName)
    ? (value as ProfileName)
    : "basic";
}

export function profileLabel(value: string | undefined) {
  return profileNames.includes(value as ProfileName)
    ? profileChoices[value as ProfileName].label
    : value || "Unknown";
}

export interface ProfileDraft {
  // Restart a running diagnostic's window. Off keeps its current expiry.
  extend: boolean;
  name: ProfileName;
  namespaces: string[];
  node: string;
  paused: boolean;
  scope: "all" | "selected";
}

type Profile = ClusterView["profile"];

export function draftFromProfile(
  profile: Profile,
  initialNode?: string,
  now = Date.now()
): ProfileDraft {
  return {
    name: asProfileName(effectiveProfileName(profile, now)),
    node: initialNode || profile.nodeUids[0] || "",
    scope: profile.namespaces.length ? "selected" : "all",
    namespaces: [...profile.namespaces],
    paused: profile.paused,
    extend: false,
  };
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function draftNamespaces(draft: ProfileDraft) {
  return draft.scope === "all" ? [] : unique(draft.namespaces);
}

// The profile a diagnostic returns to when it expires.
export function returnProfile(profile: Profile): ProfileName {
  if (profile.name === "diagnostic") {
    return profile.returnProfile === "standard" ? "standard" : "basic";
  }
  return asProfileName(profile.name);
}

function sameNamespaces(a: string[], b: string[]) {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((item) => left.has(item));
}

function namespaceSummary(values: string[]) {
  return values.length
    ? `${values.length} selected namespace${values.length === 1 ? "" : "s"}`
    : "all namespaces";
}

// The profile in effect at `now`. A diagnostic past its expiry has already
// returned, even before the next snapshot reports it.
export function effectiveProfileName(profile: Profile, now: number) {
  return profile.name === "diagnostic" && !activeDiagnostic(profile, now)
    ? returnProfile(profile)
    : profile.name;
}

// Whether the draft keeps the diagnostic already running on the same node.
export function continuesDiagnostic(
  draft: Pick<ProfileDraft, "name" | "node">,
  profile: Profile,
  now: number
) {
  const running = activeDiagnostic(profile, now);
  return (
    draft.name === "diagnostic" &&
    !!running &&
    running.nodeUids[0] === draft.node
  );
}

function profileChange(
  draft: ProfileDraft,
  profile: Profile,
  nodeName: (uid: string) => string,
  now: number
) {
  const current = asProfileName(effectiveProfileName(profile, now));
  if (draft.name !== "diagnostic") {
    return draft.name === current
      ? undefined
      : `Switch from ${profileChoices[current].label} to ${profileChoices[draft.name].label}`;
  }
  const node = draft.node ? nodeName(draft.node) : "a node";
  const returnTo = profileChoices[returnProfile(profile)].label;
  if (!continuesDiagnostic(draft, profile, now)) {
    return `Run a ${diagnosticMinutes}-minute diagnostic on ${node}, then return to ${returnTo}`;
  }
  return draft.extend
    ? `Restart the diagnostic on ${node} for ${diagnosticMinutes} minutes from apply, then return to ${returnTo}`
    : undefined;
}

// Human-readable changes the draft would request; empty when unchanged.
// Other changes keep a running diagnostic's expiry unless the draft
// explicitly restarts it.
export function draftChanges(
  draft: ProfileDraft,
  profile: Profile,
  nodeName: (uid: string) => string = (uid) => uid,
  now = Date.now()
) {
  const changes: string[] = [];
  const change = profileChange(draft, profile, nodeName, now);
  if (change) {
    changes.push(change);
  }
  const namespaces = draftNamespaces(draft);
  if (!sameNamespaces(namespaces, profile.namespaces)) {
    changes.push(
      `Collect pod metrics in ${namespaceSummary(namespaces)} instead of ${namespaceSummary(profile.namespaces)}`
    );
  }
  if (draft.paused !== profile.paused) {
    changes.push(
      draft.paused ? "Pause new samples" : "Resume collecting new samples"
    );
  }
  return changes;
}

export function namespaceProblem(value: string, selected: string[]) {
  const name = value.trim();
  if (!name) {
    return "Enter a namespace name.";
  }
  if (name.length > namespaceMaxLength) {
    return `Namespace names have at most ${namespaceMaxLength} characters.`;
  }
  if (name.includes(",") || whitespace.test(name)) {
    return "Enter one namespace at a time, without spaces or commas.";
  }
  if (selected.includes(name)) {
    return `${name} is already selected.`;
  }
  if (selected.length >= namespaceLimit) {
    return `At most ${namespaceLimit} namespaces can be selected. Remove one first, or collect from all namespaces.`;
  }
  return;
}

// A kept expiry this close could lapse before the hub accepts the request.
const keepMarginMs = 30_000;

function diagnosticProblem(
  draft: ProfileDraft,
  nodes: Entity[],
  profile: Profile | undefined,
  now: number
) {
  if (draft.name !== "diagnostic") {
    return;
  }
  if (!nodes.length) {
    return "Diagnostics need a node in the cluster inventory. Wait for the observer to report nodes.";
  }
  if (!nodes.some((node) => node.uid === draft.node)) {
    return "Choose the node to run the diagnostic on.";
  }
  if (!profile || draft.extend || !continuesDiagnostic(draft, profile, now)) {
    return;
  }
  const running = activeDiagnostic(profile, now);
  if (running && running.expiresAt - now < keepMarginMs) {
    return `The diagnostic ends in under ${keepMarginMs / 1000} seconds. Restart its window, or wait for it to return to ${profileChoices[running.returnTo].label} and apply then.`;
  }
  return;
}

// Problems that block applying the draft, written as next steps. With the
// current profile, a running diagnostic about to end is also flagged.
export function draftProblems(
  draft: ProfileDraft,
  nodes: Entity[],
  profile?: Profile,
  now = Date.now()
) {
  const problems: string[] = [];
  const diagnostic = diagnosticProblem(draft, nodes, profile, now);
  if (diagnostic) {
    problems.push(diagnostic);
  }
  const namespaces = draftNamespaces(draft);
  if (draft.scope === "selected" && namespaces.length === 0) {
    problems.push(
      "Select at least one namespace, or collect pod metrics from all namespaces."
    );
  }
  if (namespaces.length > namespaceLimit) {
    problems.push(
      `Select at most ${namespaceLimit} namespaces (currently ${namespaces.length}), or collect from all namespaces.`
    );
  }
  return problems;
}

// The profile sent to the hub. The hub assigns the next revision and the
// profile a diagnostic returns to. A diagnostic already running on the same
// node keeps its expiry unless the draft restarts it.
export function profileRequest(
  draft: ProfileDraft,
  profile: Profile,
  now: number
) {
  const diagnostic = draft.name === "diagnostic";
  const keep = !draft.extend && continuesDiagnostic(draft, profile, now);
  return {
    name: draft.name,
    revision: profile.revision,
    appliedRevision: 0,
    paused: draft.paused,
    nodeUids: diagnostic && draft.node ? [draft.node] : [],
    namespaces: draftNamespaces(draft),
    ...(diagnostic
      ? {
          expiresAt: keep
            ? profile.expiresAt
            : new Date(now + diagnosticMinutes * 60_000).toISOString(),
        }
      : {}),
  };
}

export function activeDiagnostic(profile: Profile, now: number) {
  const expiresAt = profile.expiresAt ? Date.parse(profile.expiresAt) : 0;
  if (profile.name !== "diagnostic" || !(expiresAt > now)) {
    return;
  }
  return {
    nodeUids: profile.nodeUids,
    expiresAt,
    returnTo: returnProfile(profile),
  };
}

// Namespaces known from inventory plus any already configured, so a
// configured namespace that disappeared stays visible and removable.
export function knownNamespaces(view: ClusterView) {
  const names = new Set<string>(view.profile.namespaces);
  for (const entity of view.inventory.entities) {
    if (entity.kind === "Namespace") {
      names.add(entity.name);
    } else if (entity.namespace) {
      names.add(entity.namespace);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export type AckStatus = "acknowledged" | "pending" | "unavailable";

export interface NodeAckRow {
  ack?: NonNullable<ClusterView["heartbeat"]["nodes"]>[number];
  diagnosticTarget: boolean;
  name: string;
  status: AckStatus;
  uid: string;
}

function ackStatus(outcome: string): AckStatus {
  if (outcome.startsWith("Acknowledged")) {
    return "acknowledged";
  }
  return outcome.startsWith("Pending") ? "pending" : "unavailable";
}

export function nodeAcknowledgments(
  view: ClusterView,
  now: number
): NodeAckRow[] {
  const diagnostic = view.profile.name === "diagnostic";
  return view.inventory.entities
    .filter((entity) => entity.kind === "Node")
    .map((node) => ({
      uid: node.uid,
      name: node.name,
      status: ackStatus(nodeProfileOutcome(view, node.uid, now)),
      diagnosticTarget: diagnostic && view.profile.nodeUids.includes(node.uid),
      ack: view.heartbeat.nodes?.find((item) => item.nodeUid === node.uid),
    }))
    .sort(
      (a, b) =>
        Number(b.diagnosticTarget) - Number(a.diagnosticTarget) ||
        a.name.localeCompare(b.name)
    );
}

export function ackCounts(rows: NodeAckRow[]) {
  return {
    total: rows.length,
    acknowledged: rows.filter((row) => row.status === "acknowledged").length,
    pending: rows.filter((row) => row.status === "pending").length,
    unavailable: rows.filter((row) => row.status === "unavailable").length,
  };
}

type RequestPhase =
  | "syncing"
  | "superseded"
  | "observer-stale"
  | "waiting"
  | "partial"
  | "complete";

// Where a requested revision stands, from the latest snapshot.
export function requestProgress(
  view: ClusterView,
  revision: number,
  now: number
) {
  const counts = ackCounts(nodeAcknowledgments(view, now));
  const observerReceived = view.profile.appliedRevision >= revision;
  let phase: RequestPhase;
  if (view.profile.revision < revision) {
    phase = "syncing";
  } else if (view.profile.revision > revision) {
    phase = "superseded";
  } else if (freshness(view.cluster.heartbeatAt, now) !== "fresh") {
    phase = "observer-stale";
  } else if (counts.total > 0 && counts.acknowledged === counts.total) {
    phase = "complete";
  } else {
    phase = counts.acknowledged > 0 ? "partial" : "waiting";
  }
  return { phase, observerReceived, ...counts };
}

// While a profile request awaits acknowledgment, the snapshot is refreshed on
// a capped backoff that ends with the patience window.
export const ackPatienceMs = 3 * 60_000;
const ackPollStepsMs = [10_000, 20_000, 30_000];

// Delay before refresh `attempt` (0-based) when `elapsedMs` have passed since
// the request, or undefined once that refresh would fall outside the window.
export function ackPollDelay(attempt: number, elapsedMs: number) {
  const delay =
    ackPollStepsMs[Math.min(attempt, ackPollStepsMs.length - 1)] ??
    ackPatienceMs;
  return elapsedMs + delay > ackPatienceMs ? undefined : delay;
}

// A profile request the hub accepted: its revision and when it was sent.
export interface AckRequest {
  at: number;
  revision: number;
}

// Whether a request still needs snapshot refreshes to show acknowledgments:
// inside the patience window, not complete or superseded, and with nodes
// that could acknowledge it.
export function awaitingAcknowledgment(
  view: ClusterView,
  request: AckRequest | undefined,
  now: number
) {
  if (!request || now - request.at >= ackPatienceMs) {
    return false;
  }
  const progress = requestProgress(view, request.revision, now);
  return (
    progress.total > 0 &&
    progress.phase !== "complete" &&
    progress.phase !== "superseded"
  );
}

// When the most recent request still awaiting acknowledgment was sent, so a
// single page-wide poller can back off from it; undefined when none waits.
export function latestPendingRequest(
  views: ClusterView[],
  requests: Partial<Record<string, AckRequest>>,
  now: number
) {
  let latest: number | undefined;
  for (const view of views) {
    const request = requests[view.cluster.id];
    if (
      request &&
      awaitingAcknowledgment(view, request, now) &&
      (latest === undefined || request.at > latest)
    ) {
      latest = request.at;
    }
  }
  return latest;
}

export type ObservationKind = "heartbeat" | "inventory";

// Heartbeats arrive about every 15 s, while inventory is reconciled about
// every 60 s, so each is judged against its own staleness budget.
export function observationFreshness(
  kind: ObservationKind,
  at: string | null | undefined,
  now: number
) {
  return kind === "inventory"
    ? inventoryFreshness(at, now)
    : freshness(at, now);
}

export interface DeliveryStat {
  definition: string;
  term: string;
  value: string;
  warn: boolean;
}

type Heartbeat = ClusterView["heartbeat"];

const deliveryTerms: {
  term: string;
  definition: string;
  read: (heartbeat: Heartbeat) => number;
  format: (value: number) => string;
}[] = [
  {
    term: "Buffered on agent",
    definition:
      "Telemetry waiting in the observer's bounded local spool for the hub to accept it. It drains once delivery succeeds.",
    read: (heartbeat) => heartbeat.queueBytes,
    format: (value) => formatBytes(value),
  },
  {
    term: "Dropped",
    definition:
      "Batches the observer or node collectors discarded because a bounded buffer was full or entries expired. Dropped samples are missing, not zero.",
    read: (heartbeat) => heartbeat.dropped,
    format: String,
  },
  {
    term: "Rejected points",
    definition:
      "Data points the hub refused, for example with an unknown unit, entity or an out-of-range time.",
    read: (heartbeat) => heartbeat.rejectedPoints,
    format: String,
  },
];

function deliveryNote(state: ReturnType<typeof freshness>) {
  if (state === "stale") {
    return "The heartbeat is stale, so these are the last values the observer reported. Current buffering, drops and rejections are unknown.";
  }
  if (state === "clock skew") {
    return "The heartbeat time is ahead of this browser's clock, so these last reported values cannot be confirmed as current.";
  }
  return;
}

// Delivery counters from the latest heartbeat. Without a fresh heartbeat they
// are last-reported values, never a verified current zero.
export function deliveryHealth(view: ClusterView, now: number) {
  const state = freshness(view.cluster.heartbeatAt, now);
  const reported = state !== "unknown";
  const current = state === "fresh";
  const stats: DeliveryStat[] = deliveryTerms.map(
    ({ term, definition, read, format }) => {
      const raw = read(view.heartbeat);
      let value = "Not reported";
      if (reported) {
        value = current ? format(raw) : `${format(raw)} (last reported)`;
      }
      return {
        term,
        definition,
        value,
        warn: reported && (!current || raw > 0),
      };
    }
  );
  return { stats, note: deliveryNote(state) };
}

export function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 ** 2) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
