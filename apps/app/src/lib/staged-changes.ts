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
  draftFieldChanges,
  draftFromProfile,
  draftNamespaces,
  draftProblems,
  effectiveProfileName,
  nodeNamer,
  type ProfileDraft,
  profileChoices,
  profileLabel,
  type RequestProgress,
  requestProgress,
  returnProfile,
} from "../components/collection-model";
import { minutesLeft } from "./install-enrollment";

// Railway-style staged changes for collection settings. Edits wait here, per
// cluster, until the operator applies or discards them. The store lives in
// this tab's memory only: it survives switching project tabs, is never
// written to storage, and is gone on reload. The hub profile stays the
// source of truth; a staged draft only counts while the profile it was
// staged against is still the one in effect.

type Profile = ClusterView["profile"];

export interface StagedEntry {
  // Revision and effective profile the draft was staged against.
  base: string;
  draft: ProfileDraft;
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
  requests: Readonly<Record<string, AckRequest>>;
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
      [id]: { base: profileBase(view.profile, now), draft },
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

function clearedReason(view: ClusterView, entry: StagedEntry) {
  const [revision] = entry.base.split(":");
  if (Number(revision) !== view.profile.revision) {
    return `The collection profile changed to revision ${view.profile.revision} after you staged these changes, so they were discarded. Review the current settings and stage them again.`;
  }
  return "The diagnostic ended after you staged these changes, so they were discarded rather than starting it again. Review the current settings and stage them again.";
}

// Drops drafts whose profile changed underneath them and says why. Requests
// in flight are left alone: their own revision lands first.
export function pruneStaged(views: ClusterView[], now: number) {
  const stale = views.filter((view) => {
    const entry = state.entries[view.cluster.id];
    return (
      entry &&
      !state.applying[view.cluster.id] &&
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
      cleared[view.cluster.id] = clearedReason(view, entry);
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

// What the settings form shows: the staged draft, else the profile.
export function draftFor(
  current: StagedState,
  view: ClusterView,
  now: number,
  initialNode?: string
) {
  const nodes = clusterNodes(view);
  return (
    stagedDraftFor(current, view, now) ??
    draftFromProfile(
      view.profile,
      nodes.some((node) => node.uid === initialNode) ? initialNode : undefined,
      now
    )
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
  const node = draft.node ? nodeName(draft.node) : "a node";
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
  const node = draft.node ? nodeNamer(view)(draft.node) : "the node";
  const returnTo = profileChoices[returnProfile(view.profile)].label;
  if (continuesDiagnostic(draft, view.profile, now) && !draft.extend) {
    return `The diagnostic on ${node} keeps its current end time, then returns to ${returnTo}.`;
  }
  return `The diagnostic on ${node} expires ${diagnosticMinutes} minutes after applying, then returns to ${returnTo}. The node enforces the expiry itself.`;
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
  request?: AckRequest;
  view: ClusterView;
}

// Requests being sent or still settling, for compact progress: inside the
// patience window, not superseded, and complete only briefly.
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
    const age = request ? now - request.at : Number.POSITIVE_INFINITY;
    if (!request || age >= ackPatienceMs) {
      return [];
    }
    const progress = requestProgress(view, request.revision, now);
    const settled =
      progress.phase === "superseded" ||
      (progress.phase === "complete" && age >= completeVisibleMs);
    return settled ? [] : [{ view, request, progress }];
  });
}
