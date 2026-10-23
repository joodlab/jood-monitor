import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  type CounterWatch,
  type DeliveryWatch,
  latestChange,
  recentRise,
} from "../lib/delivery-watch";
import {
  freshness,
  inventoryFreshness,
  nodeProfileOutcome,
} from "../lib/metrics";
import {
  formatClock,
  formatDateTime,
  knownTime,
  timeZoneLabel,
} from "../lib/time";

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
      "Node resources every 60s. Inventory and pod status through API reconciliation. No pod or container CPU/memory is collected.",
  },
  standard: {
    label: "Standard",
    detail:
      "Node, pod and container CPU/memory every 30s when Metrics API is available. Host counters every 60s, stored and available through the history API but not yet charted in the dashboard.",
  },
  diagnostic: {
    label: "Diagnostic",
    detail:
      "Selected host sources every 5s on one node, bounded in time. Host samples are stored and available through the history API but not yet charted in the dashboard. Upstream pod Metrics API resolution stays unchanged.",
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

export function draftNamespaces(draft: ProfileDraft) {
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

// Whether the draft keeps the diagnostic already running. A diagnostic can
// run on several nodes; a draft naming any of them continues it.
export function continuesDiagnostic(
  draft: Pick<ProfileDraft, "name" | "node">,
  profile: Profile,
  now: number
) {
  const running = activeDiagnostic(profile, now);
  return (
    draft.name === "diagnostic" &&
    !!running &&
    running.nodeUids.includes(draft.node)
  );
}

// The nodes a diagnostic draft covers: every node of the diagnostic it
// continues, so applying other changes never drops one, else its own node.
export function diagnosticNodes(
  draft: Pick<ProfileDraft, "name" | "node">,
  profile: Profile,
  now: number
) {
  if (draft.name !== "diagnostic") {
    return [];
  }
  if (continuesDiagnostic(draft, profile, now)) {
    return [...profile.nodeUids];
  }
  return draft.node ? [draft.node] : [];
}

interface NodeOption {
  label: string;
  value: string;
}

// The diagnostic node choices. A diagnostic running on several nodes is one
// choice, valued by its first node: picking any of them keeps it on all of
// them, so they are never offered one by one.
export function diagnosticNodeOptions(
  nodes: Entity[],
  profile: Profile,
  now: number
): NodeOption[] {
  const options = (items: Entity[]) =>
    items.map((node) => ({ value: node.uid, label: node.name }));
  const running = activeDiagnostic(profile, now)?.nodeUids ?? [];
  const [first] = running;
  if (!first || running.length < 2) {
    return options(nodes);
  }
  const name = (uid: string) =>
    nodes.find((node) => node.uid === uid)?.name ?? uid;
  return [
    { value: first, label: `${running.map(name).join(", ")} (running)` },
    ...options(nodes.filter((node) => !running.includes(node.uid))),
  ];
}

// Nodes of the diagnostic the draft continues that left the inventory. The
// request keeps every node it runs on, and the hub refuses unknown ones.
function departedNodes(
  draft: ProfileDraft,
  nodes: Entity[],
  profile: Profile | undefined,
  now: number
) {
  if (!(profile && continuesDiagnostic(draft, profile, now))) {
    return [];
  }
  return profile.nodeUids.filter(
    (uid) => !nodes.some((node) => node.uid === uid)
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
  const node =
    diagnosticNodes(draft, profile, now).map(nodeName).join(", ") || "a node";
  const returnTo = profileChoices[returnProfile(profile)].label;
  if (!continuesDiagnostic(draft, profile, now)) {
    return `Run a ${diagnosticMinutes}-minute diagnostic on ${node}, then return to ${returnTo}`;
  }
  return draft.extend
    ? `Restart the diagnostic on ${node} for ${diagnosticMinutes} minutes from apply, then return to ${returnTo}`
    : undefined;
}

// The settings a draft can change. Each maps to one staged change.
export type DraftField = "profile" | "namespaces" | "paused";

interface DraftFieldChange {
  field: DraftField;
  summary: string;
}

// The changes the draft would request, per setting; empty when unchanged.
// Other changes keep a running diagnostic's expiry unless the draft
// explicitly restarts it.
export function draftFieldChanges(
  draft: ProfileDraft,
  profile: Profile,
  nodeName: (uid: string) => string = (uid) => uid,
  now = Date.now()
) {
  const changes: DraftFieldChange[] = [];
  const change = profileChange(draft, profile, nodeName, now);
  if (change) {
    changes.push({ field: "profile", summary: change });
  }
  const namespaces = draftNamespaces(draft);
  if (!sameNamespaces(namespaces, profile.namespaces)) {
    changes.push({
      field: "namespaces",
      summary: `Collect pod metrics in ${namespaceSummary(namespaces)} instead of ${namespaceSummary(profile.namespaces)}`,
    });
  }
  if (draft.paused !== profile.paused) {
    changes.push({
      field: "paused",
      summary: draft.paused
        ? "Pause new samples"
        : "Resume collecting new samples",
    });
  }
  return changes;
}

// Human-readable changes the draft would request; empty when unchanged.
export function draftChanges(
  draft: ProfileDraft,
  profile: Profile,
  nodeName: (uid: string) => string = (uid) => uid,
  now = Date.now()
) {
  return draftFieldChanges(draft, profile, nodeName, now).map(
    (change) => change.summary
  );
}

// Why the hub schema rejected a request, as one sentence.
export function validationText(error: {
  issues: { path: PropertyKey[]; message: string }[];
}) {
  return `The request is invalid: ${error.issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "profile"} ${issue.message}`
    )
    .join("; ")}.`;
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
  const departed = departedNodes(draft, nodes, profile, now);
  if (departed.length && profile) {
    const returnTo = profileChoices[returnProfile(profile)].label;
    return `${departed.join(", ")} left the cluster inventory, so the running diagnostic cannot continue unchanged. Move it to a node it does not run on, choose another profile, or wait for it to return to ${returnTo} and apply then.`;
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

// Problems that block applying the draft, per setting, written as next
// steps. With the current profile, a running diagnostic about to end is also
// flagged.
export function draftFieldProblems(
  draft: ProfileDraft,
  nodes: Entity[],
  profile?: Profile,
  now = Date.now()
) {
  const diagnostic = diagnosticProblem(draft, nodes, profile, now);
  const namespaces = draftNamespaces(draft);
  const namespaceProblems: string[] = [];
  if (draft.scope === "selected" && namespaces.length === 0) {
    namespaceProblems.push(
      "Select at least one namespace, or collect pod metrics from all namespaces."
    );
  }
  if (namespaces.length > namespaceLimit) {
    namespaceProblems.push(
      `Select at most ${namespaceLimit} namespaces (currently ${namespaces.length}), or collect from all namespaces.`
    );
  }
  return {
    profile: diagnostic ? [diagnostic] : [],
    namespaces: namespaceProblems,
  };
}

export function draftProblems(
  draft: ProfileDraft,
  nodes: Entity[],
  profile?: Profile,
  now = Date.now()
) {
  const problems = draftFieldProblems(draft, nodes, profile, now);
  return [...problems.profile, ...problems.namespaces];
}

// The profile sent to the hub. The hub assigns the next revision and the
// profile a diagnostic returns to. A diagnostic the draft continues keeps
// every node it runs on, and its expiry unless the draft restarts it.
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
    nodeUids: diagnosticNodes(draft, profile, now),
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

export function clusterNodes(view: ClusterView) {
  return view.inventory.entities.filter((entity) => entity.kind === "Node");
}

// The node's inventory name, or its UID when the inventory has no name.
export function nodeNamer(view: ClusterView) {
  const names = new Map(
    clusterNodes(view).map((node) => [node.uid, node.name])
  );
  return (uid: string) => names.get(uid) ?? uid;
}

const capabilityLabels: Record<string, string> = {
  inventory: "Kubernetes inventory",
  host_proc: "Host counters",
  token_review: "Node identity (TokenReview)",
  metrics_api: "Metrics API",
  metrics_api_unavailable: "Metrics API unavailable",
  inventory_unavailable: "Inventory unavailable",
};

export function capabilityLabel(capability: string) {
  return capabilityLabels[capability] ?? capability;
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

export type RequestProgress = ReturnType<typeof requestProgress>;

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// A full sentence on where a requested revision stands.
export function progressText(progress: RequestProgress, revision: number) {
  const nodes = `${progress.acknowledged} of ${plural(progress.total, "node")} acknowledged`;
  const observer = progress.observerReceived
    ? "Observer received it"
    : "Waiting for the observer to pick it up (it checks about every 15 seconds)";
  switch (progress.phase) {
    case "syncing":
      return `Requested revision ${revision}. Loading the latest status…`;
    case "superseded":
      return `Revision ${revision} was replaced by a newer request.`;
    case "observer-stale":
      return `Requested revision ${revision}. The observer has no fresh heartbeat, so acknowledgments cannot be confirmed yet.`;
    case "complete":
      return `All ${plural(progress.total, "node")} acknowledged revision ${revision}.`;
    default:
      return progress.total
        ? `Requested revision ${revision}. ${observer} · ${nodes}.`
        : `Requested revision ${revision}. ${observer}. No nodes have reported yet.`;
  }
}

// A short status line for compact surfaces such as the staged-changes card.
export function progressSummary(progress: RequestProgress) {
  switch (progress.phase) {
    case "syncing":
      return "Sent, loading the latest status…";
    case "superseded":
      return "Replaced by a newer request";
    case "observer-stale":
      return "Observer heartbeat stale, acknowledgments unconfirmed";
    case "complete":
      return `All ${plural(progress.total, "node")} acknowledged`;
    default:
      if (!progress.observerReceived) {
        return "Waiting for the observer to pick it up";
      }
      return progress.total
        ? `${progress.acknowledged} of ${plural(progress.total, "node")} acknowledged`
        : "Observer received it, no nodes reported yet";
  }
}

// While a profile request awaits acknowledgment, the snapshot is refreshed on
// a capped backoff that ends with the patience window.
export const ackPatienceMs = 3 * 60_000;
// Refresh marks after the request: 10 s, 30 s, then every 30 s to the end of
// the patience window.
const ackPollMarksMs = [
  10_000, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000,
];
// A timer can fire a few milliseconds early; that tick still counts as its
// mark rather than scheduling the same mark again.
const ackPollToleranceMs = 500;

// Delay until the next refresh mark when `elapsedMs` have passed since the
// request, or undefined when no mark is left in the patience window. It
// depends only on elapsed time, so a remounted poller keeps the schedule.
export function ackPollDelay(elapsedMs: number) {
  const mark = ackPollMarksMs.find(
    (value) => value > elapsedMs + ackPollToleranceMs
  );
  return mark === undefined || mark > ackPatienceMs
    ? undefined
    : mark - elapsedMs;
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

// How a delivery counter reads: zero, a total worth noticing, or one that
// needs attention (stale, still buffering, or seen rising recently).
type DeliveryTone = "ok" | "notice" | "warn";

export interface DeliveryStat {
  definition: string;
  term: string;
  tone: DeliveryTone;
  value: string;
}

interface DeliveryOptions {
  // A saved observation: whether its heartbeat was captured. Its view's
  // heartbeatAt must already be the captured one (capturedHeartbeatAt).
  captured?: boolean;
  timeZone?: string;
  // What this page has seen of the live totals.
  watch?: DeliveryWatch;
}

type Heartbeat = ClusterView["heartbeat"];
type Freshness = ReturnType<typeof freshness>;
type CapturedFreshness = Freshness | "not evaluated";

const countFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number) {
  return countFormat.format(value);
}

interface DeliveryTerm {
  // The running total this counter is watched as, and what it counts.
  counter?: "dropped" | "rejectedPoints";
  definition: string;
  events?: string;
  format: (value: number) => string;
  read: (heartbeat: Heartbeat) => number;
  term: string;
}

const deliveryTerms: DeliveryTerm[] = [
  {
    term: "Buffered on agent",
    definition:
      "Telemetry waiting in the observer's bounded local spool for the hub to accept it. It drains once delivery succeeds.",
    read: (heartbeat) => heartbeat.queueBytes,
    format: (value) => formatBytes(value),
  },
  {
    term: "Dropped batches",
    definition:
      "Batches (inventory, cluster metrics, node host metrics forwarded by the observer, or heartbeats) the observer discarded since its process last started: its local spool was full or could not be written, an ID or token could not be made, a spooled batch was corrupt and could not be decoded, or the hub refused it outright (HTTP 400, 404, 413 or 422, for example a metrics batch over the hub's 10,000-point limit). The total resets when the observer restarts. Every dropped batch is missing data, never zero. Node collectors count batches lost before the observer accepted them in Node acknowledgments.",
    read: (heartbeat) => heartbeat.dropped,
    format: formatCount,
    counter: "dropped",
    events: "drops",
  },
  {
    term: "Rejected points",
    definition:
      "Data points the hub reported as refused in its acknowledgements of accepted metrics batches since the observer last started, for example with an unknown unit, entity or an out-of-range time. A retried batch can be counted again, so this is not a count of distinct points.",
    read: (heartbeat) => heartbeat.rejectedPoints,
    format: formatCount,
    counter: "rejectedPoints",
    events: "rejections",
  },
];

function zonedClock(time: string | number, timeZone: string) {
  return `${formatClock(time, timeZone)} ${timeZoneLabel(timeZone, knownTime(time))}`;
}

// What this page saw a counter do: rise, reset, or hold still. The observer
// reports totals only, so a change is placed by the heartbeat it was first
// seen in, never by when the drops happened.
function watchedChange(
  counter: CounterWatch,
  term: DeliveryTerm,
  timeZone: string
) {
  const change = latestChange(counter);
  if (change === "reset") {
    return `the total went down (${term.format(counter.resetFrom ?? 0)} → ${term.format(counter.lastValue)}) in the heartbeat received ${zonedClock(counter.resetAt ?? "", timeZone)}; the observer's counter reset, usually after a restart`;
  }
  if (change === "rise") {
    return `rose by ${term.format(counter.risenBy)} since this page opened (first higher total seen in the heartbeat the hub received at ${zonedClock(counter.firstHigherHeartbeatAt ?? "", timeZone)})`;
  }
  if (counter.lastValue > 0) {
    const opened = formatClock(counter.firstSeen.at, timeZone).slice(0, 5);
    return `watching since this page opened at ${opened} ${timeZoneLabel(timeZone, counter.firstSeen.at)}; no rise seen (the observer does not report when ${term.events} happened)`;
  }
  return;
}

const backlogText =
  "the observer is draining a backlog, so whether the total is still rising is unconfirmed";

function watchText(
  term: DeliveryTerm,
  counter: CounterWatch | undefined,
  backlog: boolean,
  timeZone: string
) {
  const change = counter && watchedChange(counter, term, timeZone);
  const quiet = !counter || latestChange(counter) === undefined;
  // With a backlog the reports may lag, so "no rise seen" is not claimed.
  const parts = [quiet && backlog ? undefined : change, backlog && backlogText];
  return parts.filter(Boolean).join("; ");
}

function liveStat(
  term: DeliveryTerm,
  heartbeat: Heartbeat,
  state: Freshness,
  now: number,
  options: DeliveryOptions
): Pick<DeliveryStat, "tone" | "value"> {
  const raw = term.read(heartbeat);
  if (state === "unknown") {
    return { tone: "ok", value: "Not reported" };
  }
  if (state !== "fresh") {
    return { tone: "warn", value: `${term.format(raw)} (last reported)` };
  }
  const backlog = heartbeat.queueBytes > 0;
  const counter = term.counter && options.watch?.[term.counter];
  const watched = term.counter
    ? watchText(term, counter, backlog, options.timeZone ?? "UTC")
    : "";
  let tone: DeliveryTone = raw > 0 ? "notice" : "ok";
  if (backlog || recentRise(counter, now)) {
    tone = "warn";
  }
  return {
    tone,
    value: watched ? `${term.format(raw)} · ${watched}` : term.format(raw),
  };
}

// A saved observation's counters, from the heartbeat captured with it and
// judged at its inventory's receipt. Nothing here is current.
function capturedStat(
  term: DeliveryTerm,
  view: ClusterView,
  state: CapturedFreshness,
  options: DeliveryOptions
): Pick<DeliveryStat, "tone" | "value"> {
  if (!options.captured) {
    return { tone: "ok", value: "Not captured with this observation" };
  }
  if (state === "unknown") {
    return { tone: "ok", value: "No heartbeat before this inventory" };
  }
  const raw = term.read(view.heartbeat);
  const timeZone = options.timeZone ?? "UTC";
  const received = knownTime(view.cluster.receivedAt);
  const value =
    received == null
      ? `${term.format(raw)} (as captured)`
      : `${term.format(raw)} as captured at ${formatDateTime(received, timeZone, { year: "auto" })} ${timeZoneLabel(timeZone, received)}`;
  const judged = state === "fresh" || state === "not evaluated";
  let tone: DeliveryTone = raw > 0 ? "notice" : "ok";
  if (!judged || view.heartbeat.queueBytes > 0) {
    tone = "warn";
  }
  return { tone, value };
}

function liveNote(state: Freshness) {
  if (state === "stale") {
    return "The heartbeat is stale, so these are the last values the observer reported. Current buffering, drops and rejections are unknown.";
  }
  if (state === "clock skew") {
    return "The heartbeat time is ahead of this browser's clock, so these last reported values cannot be confirmed as current.";
  }
  return;
}

function capturedNote(state: CapturedFreshness) {
  if (state === "stale") {
    return "The heartbeat was already stale when this inventory arrived, so these are the last values the observer had reported by then.";
  }
  if (state === "clock skew") {
    return "The heartbeat time was ahead of the hub's receipt of this inventory, so these values cannot be confirmed for that time.";
  }
  if (state === "not evaluated") {
    return "The hub's receipt time of this inventory was not retained, so the heartbeat's freshness was not evaluated.";
  }
  return;
}

// Delivery counters from the latest heartbeat. Without a fresh heartbeat they
// are last-reported values, never a verified current zero. Live, a total this
// page saw rise recently needs attention; one it never saw move is a running
// total since the observer started, worth noticing but not dated. A saved
// observation's counters are judged at `now`, its inventory's receipt, and
// are never compared with the browser's clock or current values.
export function deliveryHealth(
  view: ClusterView,
  now: number,
  options: DeliveryOptions = {}
) {
  const state = freshness(view.cluster.heartbeatAt, now);
  const stat = (
    term: DeliveryTerm,
    values: Pick<DeliveryStat, "tone" | "value">
  ) => ({
    term: term.term,
    definition: term.definition,
    ...values,
  });
  if (options.captured === undefined) {
    return {
      stats: deliveryTerms.map((term) =>
        stat(term, liveStat(term, view.heartbeat, state, now, options))
      ),
      note: liveNote(state),
    };
  }
  const judged: CapturedFreshness =
    state !== "unknown" && knownTime(view.cluster.receivedAt) == null
      ? "not evaluated"
      : state;
  return {
    stats: deliveryTerms.map((term) =>
      stat(term, capturedStat(term, view, judged, options))
    ),
    note: options.captured ? capturedNote(judged) : undefined,
  };
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
