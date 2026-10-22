import type { ClusterView } from "@jood-monitor/api-client";
import { useSyncExternalStore } from "react";
import {
  type AckRequest,
  ackPatienceMs,
  activeDiagnostic,
  clusterNodes,
  continuesDiagnostic,
  type DraftField,
  diagnosticMinutes,
  diagnosticNodes,
  draftFieldChanges,
  draftFromProfile,
  draftNamespaces,
  draftProblems,
  effectiveProfileName,
  nodeNamer,
  type ProfileDraft,
  profileChoices,
  profileLabel,
  profileRequest,
  type RequestProgress,
  requestProgress,
  returnProfile,
  validationText,
} from "../components/collection-model";
import { profileSchema } from "../schemas/clusters";
import { minutesLeft } from "./install-enrollment";
import { requestError } from "./install-errors";

// Railway-style staged changes for collection settings. Edits wait here, per
// cluster, until the operator applies or discards them. The store lives in
// this tab's memory only: it survives switching project tabs, is never
// written to storage, and is gone on reload, so the browser asks before the
// tab unloads with drafts. The hub profile stays the source of truth; a
// staged draft only counts while the profile it was staged against is still
// the one in effect.

type Profile = ClusterView["profile"];

export interface StagedEntry {
  // Revision and effective profile the draft was staged against.
  base: string;
  draft: ProfileDraft;
  // The cluster's workspace, so views without a live snapshot (frozen) can
  // tell which drafts are in their scope.
  workspaceId: string;
}

// A request the hub accepted, as this tab follows it.
interface StagedRequest extends AckRequest {
  // When this tab first saw every node acknowledge it.
  completedAt?: number;
  // The operator dismissed it from compact progress. Settings still shows it.
  dismissed?: true;
}

export interface StagedState {
  // Clusters whose request is on its way to the hub.
  applying: Readonly<Record<string, true>>;
  // Drafts dropped because the profile changed underneath them: why.
  cleared: Readonly<Record<string, string>>;
  entries: Readonly<Record<string, StagedEntry>>;
  // Why the last apply failed, per cluster.
  failures: Readonly<Record<string, string>>;
  // The latest request the hub accepted, per cluster.
  requests: Readonly<Record<string, StagedRequest>>;
}

const emptyState: StagedState = {
  applying: {},
  cleared: {},
  entries: {},
  failures: {},
  requests: {},
};

let state = emptyState;
const listeners = new Set<() => void>();

function commit(next: StagedState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function without<T>(record: Readonly<Record<string, T>>, keys: string[]) {
  if (!keys.some((key) => key in record)) {
    return record;
  }
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.includes(key))
  );
}

export function subscribeStaged(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function stagedSnapshot() {
  return state;
}

// The server render has nothing staged.
export function useStagedState() {
  return useSyncExternalStore(
    subscribeStaged,
    stagedSnapshot,
    () => emptyState
  );
}

// Unloading the tab now would lose a draft or cut off an apply on its way to
// the hub.
function unloadLoses(current: StagedState) {
  return (
    Object.keys(current.entries).length > 0 ||
    Object.keys(current.applying).length > 0
  );
}

function confirmUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Older Chromium shows the prompt only when returnValue is set too.
  event.returnValue = true;
}

type UnloadListener = (event: BeforeUnloadEvent) => void;

interface UnloadTarget {
  addEventListener(type: "beforeunload", listener: UnloadListener): void;
  removeEventListener(type: "beforeunload", listener: UnloadListener): void;
}

// Keeps a beforeunload prompt on `target` only while something would be
// lost, so a tab with nothing staged unloads without asking (and stays
// eligible for the back/forward cache). Returns a function that stops it.
export function guardUnload(target: UnloadTarget) {
  let armed = false;
  const sync = () => {
    const needed = unloadLoses(state);
    if (needed === armed) {
      return;
    }
    armed = needed;
    if (armed) {
      target.addEventListener("beforeunload", confirmUnload);
    } else {
      target.removeEventListener("beforeunload", confirmUnload);
    }
  };
  const unsubscribe = subscribeStaged(sync);
  sync();
  return () => {
    unsubscribe();
    if (armed) {
      armed = false;
      target.removeEventListener("beforeunload", confirmUnload);
    }
  };
}

// Guarded from module load rather than by the Apply card, which only the
// canvas and Settings mount. The server has no window and nothing staged.
if (typeof window !== "undefined") {
  guardUnload(window);
}

// The profile state a draft is staged against. A new revision or an ended
// diagnostic changes it, so a draft touched before either cannot silently
// re-arm a diagnostic or undo another operator's change.
export function profileBase(profile: Profile, now: number) {
  return `${profile.revision}:${effectiveProfileName(profile, now)}`;
}

// A draft with nothing to apply and nothing the operator chose that differs
// from the profile (such as an empty namespace selection still being built).
export function isPristine(draft: ProfileDraft, profile: Profile, now: number) {
  return (
    !draft.extend &&
    draft.scope === (profile.namespaces.length ? "selected" : "all") &&
    draftFieldChanges(draft, profile, undefined, now).length === 0
  );
}

export function stageDraft(
  view: ClusterView,
  draft: ProfileDraft,
  now: number
) {
  const id = view.cluster.id;
  const keys = [id];
  if (isPristine(draft, view.profile, now)) {
    commit({
      ...state,
      entries: without(state.entries, keys),
      failures: without(state.failures, keys),
    });
    return;
  }
  commit({
    ...state,
    entries: {
      ...state.entries,
      [id]: {
        base: profileBase(view.profile, now),
        draft,
        workspaceId: view.cluster.workspaceId,
      },
    },
    cleared: without(state.cleared, keys),
    failures: without(state.failures, keys),
  });
}

export function discardStaged(clusterIds: string[]) {
  commit({
    ...state,
    entries: without(state.entries, clusterIds),
    failures: without(state.failures, clusterIds),
  });
}

export function dismissCleared(clusterId: string) {
  commit({ ...state, cleared: without(state.cleared, [clusterId]) });
}

export function markApplying(clusterIds: string[]) {
  const applying = { ...state.applying };
  for (const id of clusterIds) {
    applying[id] = true;
  }
  commit({ ...state, applying, failures: without(state.failures, clusterIds) });
}

// The hub accepted the request: the draft is no longer pending, and its
// revision now awaits acknowledgments.
export function applySucceeded(clusterId: string, request: AckRequest) {
  const keys = [clusterId];
  commit({
    ...state,
    applying: without(state.applying, keys),
    entries: without(state.entries, keys),
    failures: without(state.failures, keys),
    requests: { ...state.requests, [clusterId]: request },
  });
}

// The draft stays staged so the operator can fix it or retry.
export function applyFailed(clusterId: string, message: string) {
  commit({
    ...state,
    applying: without(state.applying, [clusterId]),
    failures: { ...state.failures, [clusterId]: message },
  });
}

const endedNotice =
  "The diagnostic ended after you staged these changes, so nothing was sent. Review the current settings and stage them again.";

type ProfileInput = ReturnType<typeof profileSchema.parse>;

type ProfileSend = (
  clusterId: string,
  profile: ProfileInput
) => Promise<{ revision: number }>;

// Sends one cluster's staged profile through `send`. Validity is checked
// again on the real clock, with the same `now` the request is built from:
// the display clock ticks every 15 s, so a diagnostic can end between the
// last check and the click, and a request built then would re-arm it.
// Resolves true when the hub accepted the request.
export async function applyStagedCluster(
  target: { draft: ProfileDraft; view: ClusterView },
  send: ProfileSend,
  clock: () => number = Date.now
) {
  const { view, draft } = target;
  const id = view.cluster.id;
  const now = clock();
  const entry = state.entries[id];
  const problems = draftProblems(draft, clusterNodes(view), view.profile, now);
  if (
    !entry ||
    entry.base !== profileBase(view.profile, now) ||
    problems.length > 0
  ) {
    applyFailed(id, problems[0] ?? endedNotice);
    return false;
  }
  const parsed = profileSchema.safeParse(
    profileRequest(draft, view.profile, now)
  );
  if (!parsed.success) {
    applyFailed(id, validationText(parsed.error));
    return false;
  }
  try {
    const result = await send(id, parsed.data);
    applySucceeded(id, { revision: result.revision, at: clock() });
    return true;
  } catch (error) {
    applyFailed(id, requestError(error).message);
    return false;
  }
}

// Sends the targets' staged profiles side by side. Only the targets are
// marked applying or sent; drafts for other clusters stay staged. A failure
// keeps that cluster staged with the reason while the others still apply,
// and `accepted` runs as each request is accepted.
export async function applyStagedClusters(
  targets: { draft: ProfileDraft; view: ClusterView }[],
  send: ProfileSend,
  accepted: () => void = () => undefined,
  clock: () => number = Date.now
) {
  markApplying(targets.map((target) => target.view.cluster.id));
  await Promise.all(
    targets.map(async (target) => {
      if (await applyStagedCluster(target, send, clock)) {
        accepted();
      }
    })
  );
}

// Records when each request is first seen fully acknowledged, so compact
// progress shows the outcome for a while from then, not from sending.
export function settleRequests(views: ClusterView[], now: number) {
  const completed = views.flatMap((view) => {
    const id = view.cluster.id;
    const request = state.requests[id];
    return request &&
      request.completedAt === undefined &&
      requestProgress(view, request.revision, now).phase === "complete"
      ? [[id, { ...request, completedAt: now }] as const]
      : [];
  });
  if (completed.length) {
    commit({
      ...state,
      requests: { ...state.requests, ...Object.fromEntries(completed) },
    });
  }
}

// Hides requests from compact progress. Settings keeps showing them.
export function dismissRequests(clusterIds: string[]) {
  const dismissed = clusterIds.flatMap((id) => {
    const request = state.requests[id];
    return request && !request.dismissed
      ? [[id, { ...request, dismissed: true as const }] as const]
      : [];
  });
  if (dismissed.length) {
    commit({
      ...state,
      requests: { ...state.requests, ...Object.fromEntries(dismissed) },
    });
  }
}

// Sending, or accepted while the snapshot still shows an older revision. The
// settings form would show the profile from before the apply, so it stays
// locked, and drafts are not judged stale until the new revision lands.
export function awaitingSnapshot(current: StagedState, view: ClusterView) {
  const id = view.cluster.id;
  const request = current.requests[id];
  return (
    !!current.applying[id] ||
    (!!request && view.profile.revision < request.revision)
  );
}

function clearedReason(
  current: StagedState,
  view: ClusterView,
  entry: StagedEntry
) {
  const [revision] = entry.base.split(":");
  const latest = view.profile.revision;
  if (Number(revision) === latest) {
    return "The diagnostic ended after you staged these changes, so they were discarded rather than starting it again. Review the current settings and stage them again.";
  }
  if (current.requests[view.cluster.id]?.revision === latest) {
    return `Your applied changes (revision ${latest}) landed after you made these edits, so the edits were discarded. Review the current settings and stage them again.`;
  }
  return `The collection profile changed to revision ${latest} after you staged these changes, so they were discarded. Review the current settings and stage them again.`;
}

// Drops drafts whose profile changed underneath them and says why. Requests
// in flight, or accepted but not in the snapshot yet, are left alone: their
// own revision lands first.
export function pruneStaged(views: ClusterView[], now: number) {
  const stale = views.filter((view) => {
    const entry = state.entries[view.cluster.id];
    return (
      entry &&
      !awaitingSnapshot(state, view) &&
      entry.base !== profileBase(view.profile, now)
    );
  });
  if (!stale.length) {
    return;
  }
  const cleared = { ...state.cleared };
  for (const view of stale) {
    const entry = state.entries[view.cluster.id];
    if (entry) {
      cleared[view.cluster.id] = clearedReason(state, view, entry);
    }
  }
  const ids = stale.map((view) => view.cluster.id);
  commit({
    ...state,
    cleared,
    entries: without(state.entries, ids),
    failures: without(state.failures, ids),
  });
}

// For tests.
export function resetStaged() {
  commit(emptyState);
}

// The staged draft for a cluster while it still applies to its profile.
export function stagedDraftFor(
  current: StagedState,
  view: ClusterView,
  now: number
) {
  const entry = current.entries[view.cluster.id];
  return entry && entry.base === profileBase(view.profile, now)
    ? entry.draft
    : undefined;
}

// Whether any draft is staged for a cluster in a workspace scope ("global"
// is every workspace). For views without a live snapshot to check drafts.
export function stagedInScope(current: StagedState, scope: string) {
  return Object.values(current.entries).some(
    (entry) => scope === "global" || entry.workspaceId === scope
  );
}

// What the settings form shows: the staged draft, else the profile. A node
// requested by a deep link (the inspector) becomes the target of a draft that
// is not a diagnostic yet, so staging one uses it. It never moves a running
// or staged diagnostic: that stays an explicit, staged choice.
export function draftFor(
  current: StagedState,
  view: ClusterView,
  now: number,
  initialNode?: string
) {
  const requested = clusterNodes(view).some((node) => node.uid === initialNode)
    ? initialNode
    : undefined;
  const staged = stagedDraftFor(current, view, now);
  if (staged) {
    // The node is ignored until the draft is a diagnostic.
    return requested && staged.name !== "diagnostic"
      ? { ...staged, node: requested }
      : staged;
  }
  return draftFromProfile(
    view.profile,
    activeDiagnostic(view.profile, now) ? undefined : requested,
    now
  );
}

export function stagedFields(
  draft: ProfileDraft,
  profile: Profile,
  now: number
): ReadonlySet<DraftField> {
  return new Set(
    draftFieldChanges(draft, profile, undefined, now).map(
      (change) => change.field
    )
  );
}

const namespacePreview = 3;

function namespaceValue(namespaces: string[]) {
  if (!namespaces.length) {
    return "All namespaces";
  }
  const shown = namespaces.slice(0, namespacePreview).join(", ");
  const more = namespaces.length - namespacePreview;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function currentProfileValue(
  profile: Profile,
  nodeName: (uid: string) => string,
  now: number
) {
  const running = activeDiagnostic(profile, now);
  if (!running) {
    return profileLabel(effectiveProfileName(profile, now));
  }
  const nodes = running.nodeUids.map(nodeName).join(", ") || "a node";
  return `Diagnostic on ${nodes} (${minutesLeft(running.expiresAt, now)} left), then ${profileChoices[running.returnTo].label}`;
}

function nextProfileValue(
  draft: ProfileDraft,
  profile: Profile,
  nodeName: (uid: string) => string,
  now: number
) {
  if (draft.name !== "diagnostic") {
    return profileChoices[draft.name].label;
  }
  const node =
    diagnosticNodes(draft, profile, now).map(nodeName).join(", ") || "a node";
  const returnTo = profileChoices[returnProfile(profile)].label;
  const restart = continuesDiagnostic(draft, profile, now) ? "restarted " : "";
  return `Diagnostic on ${node}, ${restart}for ${diagnosticMinutes} min after applying, then ${returnTo}`;
}

const fieldLabels: Record<DraftField, string> = {
  profile: "Collection profile",
  namespaces: "Pod metrics namespaces",
  paused: "New samples",
};

function fieldValues(
  field: DraftField,
  draft: ProfileDraft,
  profile: Profile,
  nodeName: (uid: string) => string,
  now: number
) {
  if (field === "profile") {
    return {
      current: currentProfileValue(profile, nodeName, now),
      next: nextProfileValue(draft, profile, nodeName, now),
    };
  }
  if (field === "namespaces") {
    return {
      current: namespaceValue(profile.namespaces),
      next: namespaceValue(draftNamespaces(draft)),
    };
  }
  return {
    current: profile.paused ? "Paused" : "Collecting",
    next: draft.paused ? "Paused" : "Collecting",
  };
}

export interface StagedRow {
  current: string;
  field: DraftField;
  label: string;
  next: string;
  summary: string;
}

// The Change / Current value / New value rows for a staged draft.
export function stagedRows(
  draft: ProfileDraft,
  view: ClusterView,
  now: number
): StagedRow[] {
  const nodeName = nodeNamer(view);
  return draftFieldChanges(draft, view.profile, nodeName, now).map(
    (change) => ({
      field: change.field,
      label: fieldLabels[change.field],
      summary: change.summary,
      ...fieldValues(change.field, draft, view.profile, nodeName, now),
    })
  );
}

// Returns the draft with one setting back at the profile's value.
export function revertField(
  draft: ProfileDraft,
  profile: Profile,
  field: DraftField,
  now: number
): ProfileDraft {
  const current = draftFromProfile(profile, undefined, now);
  if (field === "profile") {
    return {
      ...draft,
      name: current.name,
      node: activeDiagnostic(profile, now) ? current.node : draft.node,
      extend: false,
    };
  }
  if (field === "namespaces") {
    return { ...draft, scope: current.scope, namespaces: current.namespaces };
  }
  return { ...draft, paused: current.paused };
}

function diagnosticNote(
  draft: ProfileDraft,
  view: ClusterView,
  now: number
): string | undefined {
  if (draft.name !== "diagnostic") {
    return;
  }
  const nodes = diagnosticNodes(draft, view.profile, now).map(nodeNamer(view));
  const node = nodes.join(", ") || "the node";
  const returnTo = profileChoices[returnProfile(view.profile)].label;
  if (continuesDiagnostic(draft, view.profile, now) && !draft.extend) {
    return `The diagnostic on ${node} keeps its current end time, then returns to ${returnTo}.`;
  }
  return `The diagnostic on ${node} expires ${diagnosticMinutes} minutes after applying, then returns to ${returnTo}. Each node enforces the expiry itself.`;
}

// What applying the draft will do beyond the values themselves.
export function stagedNotes(
  draft: ProfileDraft,
  view: ClusterView,
  now: number
) {
  const fields = stagedFields(draft, view.profile, now);
  const notes: string[] = [];
  const diagnostic = diagnosticNote(draft, view, now);
  if (diagnostic && fields.size) {
    notes.push(diagnostic);
  }
  if (fields.has("paused")) {
    notes.push(
      draft.paused
        ? "New metric samples stop until you resume. Charts show a gap for this period, never zeros."
        : "New samples resume. The paused period stays a gap in charts."
    );
  }
  if (fields.has("namespaces") && draft.scope === "selected") {
    notes.push(
      "Pods outside the selected namespaces keep inventory and status, without usage metrics."
    );
  }
  return notes;
}

export interface StagedCluster {
  applying: boolean;
  draft: ProfileDraft;
  failure?: string;
  notes: string[];
  problems: string[];
  rows: StagedRow[];
  view: ClusterView;
}

// Clusters in scope with staged changes, in the order given.
export function stagedClusters(
  current: StagedState,
  views: ClusterView[],
  now: number
): StagedCluster[] {
  return views.flatMap((view) => {
    const draft = stagedDraftFor(current, view, now);
    const rows = draft ? stagedRows(draft, view, now) : [];
    if (!(draft && rows.length)) {
      return [];
    }
    const id = view.cluster.id;
    return [
      {
        view,
        draft,
        rows,
        problems: draftProblems(draft, clusterNodes(view), view.profile, now),
        notes: stagedNotes(draft, view, now),
        failure: current.failures[id],
        applying: !!current.applying[id],
      },
    ];
  });
}

export function stagedCount(clusters: StagedCluster[]) {
  return clusters.reduce((total, cluster) => total + cluster.rows.length, 0);
}

interface StagedScope {
  // Staged clusters the card lists, applies and discards.
  clusters: StagedCluster[];
  // Changes staged for clusters the cluster filter hides.
  elsewhere: number;
  // The views the card covers.
  views: ClusterView[];
}

// What the Apply card covers. With a cluster filter it lists, applies and
// discards that cluster only; drafts for the others are counted, never
// applied or discarded out of sight.
export function stagedScope(
  current: StagedState,
  views: ClusterView[],
  cluster: string | undefined,
  now: number
): StagedScope {
  if (!cluster) {
    return {
      clusters: stagedClusters(current, views, now),
      elsewhere: 0,
      views,
    };
  }
  const shown = views.filter((view) => view.cluster.id === cluster);
  const hidden = views.filter((view) => view.cluster.id !== cluster);
  return {
    clusters: stagedClusters(current, shown, now),
    elsewhere: stagedCount(stagedClusters(current, hidden, now)),
    views: shown,
  };
}

// The Settings tab badge for a workspace scope ("global" is every
// workspace): the number of staged changes, counted as the Apply card counts
// them. A frozen dashboard shows a past profile that drafts cannot be
// compared with, so it only says drafts are waiting, never a guessed count.
export function stagedBadge(
  current: StagedState,
  scope: string,
  views: ClusterView[],
  now: number,
  live: boolean
): number | "waiting" | undefined {
  if (!live) {
    return stagedInScope(current, scope) ? "waiting" : undefined;
  }
  const count = now ? stagedCount(stagedClusters(current, views, now)) : 0;
  return count > 0 ? count : undefined;
}

// Clusters the apply would pause, which needs explicit confirmation.
export function pausingClusters(clusters: StagedCluster[]) {
  return clusters.filter(
    (cluster) => cluster.draft.paused && !cluster.view.profile.paused
  );
}

// How long a completed request stays visible in compact progress.
const completeVisibleMs = 60_000;

export interface RecentRequest {
  progress?: RequestProgress;
  request?: StagedRequest;
  // Not every node acknowledged within the patience window. It stays until
  // dismissed, superseded or acknowledged, never silently dropped.
  timedOut?: true;
  view: ClusterView;
}

function settled(
  request: StagedRequest,
  progress: RequestProgress,
  now: number
) {
  if (request.dismissed || progress.phase === "superseded") {
    return true;
  }
  return (
    progress.phase === "complete" &&
    request.completedAt !== undefined &&
    now - request.completedAt >= completeVisibleMs
  );
}

// Requests being sent or still settling, for compact progress. A completed
// request shows briefly from when completion was first seen; one still
// unacknowledged after the patience window is flagged rather than hidden.
export function recentRequests(
  current: StagedState,
  views: ClusterView[],
  now: number
): RecentRequest[] {
  return views.flatMap((view) => {
    const id = view.cluster.id;
    if (current.applying[id]) {
      return [{ view }];
    }
    const request = current.requests[id];
    if (!request) {
      return [];
    }
    const progress = requestProgress(view, request.revision, now);
    if (settled(request, progress, now)) {
      return [];
    }
    return progress.phase !== "complete" && now - request.at >= ackPatienceMs
      ? [{ view, request, progress, timedOut: true as const }]
      : [{ view, request, progress }];
  });
}
