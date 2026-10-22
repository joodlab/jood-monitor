import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { freshness, nodeProfileOutcome } from "../lib/metrics";

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
  name: ProfileName;
  namespaces: string[];
  node: string;
  paused: boolean;
  scope: "all" | "selected";
}

type Profile = ClusterView["profile"];

export function draftFromProfile(
  profile: Profile,
  initialNode?: string
): ProfileDraft {
  return {
    name: asProfileName(profile.name),
    node: initialNode || profile.nodeUids[0] || "",
    scope: profile.namespaces.length ? "selected" : "all",
    namespaces: [...profile.namespaces],
    paused: profile.paused,
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

// Human-readable changes the draft would request; empty when unchanged.
export function draftChanges(
  draft: ProfileDraft,
  profile: Profile,
  nodeName: (uid: string) => string = (uid) => uid
) {
  const changes: string[] = [];
  const current = asProfileName(profile.name);
  const diagnosticNodeChanged =
    draft.name === "diagnostic" && profile.nodeUids[0] !== draft.node;
  if (draft.name !== current || diagnosticNodeChanged) {
    changes.push(
      draft.name === "diagnostic"
        ? `Run a ${diagnosticMinutes}-minute diagnostic on ${draft.node ? nodeName(draft.node) : "a node"}, then return to ${profileChoices[returnProfile(profile)].label}`
        : `Switch from ${profileChoices[current].label} to ${profileChoices[draft.name].label}`
    );
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

// Problems that block applying the draft, written as next steps.
export function draftProblems(draft: ProfileDraft, nodes: Entity[]) {
  const problems: string[] = [];
  if (draft.name === "diagnostic") {
    if (!nodes.length) {
      problems.push(
        "Diagnostics need a node in the cluster inventory. Wait for the observer to report nodes."
      );
    } else if (!nodes.some((node) => node.uid === draft.node)) {
      problems.push("Choose the node to run the diagnostic on.");
    }
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
// profile a diagnostic returns to.
export function profileRequest(
  draft: ProfileDraft,
  profile: Profile,
  now: number
) {
  const diagnostic = draft.name === "diagnostic";
  return {
    name: draft.name,
    revision: profile.revision,
    appliedRevision: 0,
    paused: draft.paused,
    nodeUids: diagnostic && draft.node ? [draft.node] : [],
    namespaces: draftNamespaces(draft),
    ...(diagnostic
      ? {
          expiresAt: new Date(now + diagnosticMinutes * 60_000).toISOString(),
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

export function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 ** 2) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
