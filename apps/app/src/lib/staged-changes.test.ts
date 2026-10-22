import type { ClusterView } from "@jood-monitor/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { draftFromProfile } from "../components/collection-model";
import {
  applyFailed,
  applyStagedCluster,
  applyStagedClusters,
  applySucceeded,
  awaitingSnapshot,
  discardStaged,
  dismissCleared,
  dismissRequests,
  draftFor,
  guardUnload,
  isPristine,
  markApplying,
  pausingClusters,
  profileBase,
  pruneStaged,
  recentRequests,
  resetStaged,
  revertField,
  settleRequests,
  shownClusterIds,
  stageDraft,
  stagedBadge,
  stagedClusters,
  stagedCount,
  stagedDraftFor,
  stagedFields,
  stagedInScope,
  stagedNotes,
  stagedRows,
  stagedScope,
  stagedSnapshot,
  stagedWaiting,
  subscribeStaged,
} from "./staged-changes";

const now = Date.parse("2026-10-22T10:00:00.000Z");
const at = new Date(now - 10_000).toISOString();

// Synthetic cluster: two nodes, one namespace, Standard profile.
function fixture(id = "synthetic-a"): ClusterView {
  return {
    cluster: {
      id,
      name: `Synthetic ${id}`,
      environment: "staging",
      workspaceId: "synthetic",
      revoked: false,
      heartbeatAt: at,
      inventoryTime: at,
      receivedAt: at,
    },
    inventory: {
      entities: [
        { uid: "n1", name: "node-b", kind: "Node", status: "Ready" },
        { uid: "n2", name: "node-a", kind: "Node", status: "Ready" },
        { uid: "ns1", name: "shop", kind: "Namespace", status: "Active" },
      ],
      edges: [],
      sourceTime: at,
      capabilities: [],
    },
    metrics: [],
    profile: {
      name: "standard",
      revision: 4,
      appliedRevision: 4,
      nodeUids: [],
      namespaces: [],
      paused: false,
    },
    heartbeat: {
      version: "0.1.1",
      appliedRevision: 4,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "",
      capabilities: [],
      nodes: [
        {
          nodeUid: "n1",
          seenAt: at,
          appliedRevision: 4,
          profile: "standard",
          paused: false,
          dropped: 0,
        },
        {
          nodeUid: "n2",
          seenAt: at,
          appliedRevision: 4,
          profile: "standard",
          paused: false,
          dropped: 0,
        },
      ],
    },
  } as ClusterView;
}

function runningDiagnostic(view: ClusterView, minutes = 5) {
  view.profile = {
    ...view.profile,
    name: "diagnostic",
    nodeUids: ["n1"],
    returnProfile: "standard",
    expiresAt: new Date(now + minutes * 60_000).toISOString(),
  };
  return view;
}

afterEach(() => resetStaged());

describe("staging drafts", () => {
  it("stages a changed draft and notifies subscribers", () => {
    const view = fixture();
    let calls = 0;
    const unsubscribe = subscribeStaged(() => {
      calls += 1;
    });
    const draft = { ...draftFromProfile(view.profile), paused: true };
    stageDraft(view, draft, now);
    unsubscribe();
    expect(calls).toBe(1);
    expect(stagedSnapshot().entries[view.cluster.id]).toEqual({
      base: "4:standard",
      changed: true,
      draft,
      workspaceId: "synthetic",
    });
    expect(stagedDraftFor(stagedSnapshot(), view, now)).toEqual(draft);
  });

  it("drops the entry when the draft returns to the profile", () => {
    const view = fixture();
    const draft = draftFromProfile(view.profile);
    stageDraft(view, { ...draft, paused: true }, now);
    stageDraft(view, draft, now);
    expect(stagedSnapshot().entries).toEqual({});
  });

  it("keeps a choice in progress that has no change yet", () => {
    const view = fixture();
    const draft = {
      ...draftFromProfile(view.profile),
      scope: "selected" as const,
    };
    expect(isPristine(draft, view.profile, now)).toBe(false);
    stageDraft(view, draft, now);
    expect(draftFor(stagedSnapshot(), view, now).scope).toBe("selected");
    expect(stagedClusters(stagedSnapshot(), [view], now)).toEqual([]);
    // Nothing is staged yet, even where only the workspace can be checked.
    expect(stagedSnapshot().entries[view.cluster.id]?.changed).toBe(false);
    expect(stagedInScope(stagedSnapshot(), "global")).toBe(false);
  });

  it("preselects a requested node only when it is in the inventory", () => {
    const view = fixture();
    expect(draftFor(stagedSnapshot(), view, now, "n2").node).toBe("n2");
    expect(draftFor(stagedSnapshot(), view, now, "gone").node).toBe("");
  });

  it("lets a deep-linked node pick the target when other changes are staged", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    const draft = draftFor(stagedSnapshot(), view, now, "n2");
    expect(draft).toMatchObject({ node: "n2", paused: true });
    // Picking the target is not itself a change.
    expect(stagedRows(draft, view, now).map((row) => row.field)).toEqual([
      "paused",
    ]);
  });

  it("keeps the node of a staged diagnostic", () => {
    const view = fixture();
    const diagnostic = {
      ...draftFromProfile(view.profile),
      name: "diagnostic" as const,
      node: "n1",
    };
    stageDraft(view, diagnostic, now);
    expect(draftFor(stagedSnapshot(), view, now, "n2").node).toBe("n1");
  });

  it("never moves a running diagnostic from a deep link", () => {
    const view = runningDiagnostic(fixture());
    const draft = draftFor(stagedSnapshot(), view, now, "n2");
    expect(draft.node).toBe("n1");
    expect(stagedFields(draft, view.profile, now).size).toBe(0);
    // A namespace-only edit from that draft stages exactly that change.
    stageDraft(
      view,
      { ...draft, scope: "selected", namespaces: ["shop"] },
      now
    );
    const [cluster] = stagedClusters(stagedSnapshot(), [view], now);
    expect(cluster?.rows.map((row) => row.field)).toEqual(["namespaces"]);
    expect(cluster?.draft.node).toBe("n1");
  });

  it("tells which workspaces have drafts", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    expect(stagedInScope(stagedSnapshot(), "synthetic")).toBe(true);
    expect(stagedInScope(stagedSnapshot(), "other")).toBe(false);
    expect(stagedInScope(stagedSnapshot(), "global")).toBe(true);
    discardStaged([view.cluster.id]);
    expect(stagedInScope(stagedSnapshot(), "global")).toBe(false);
  });

  it("discards selected clusters only", () => {
    const a = fixture("a");
    const b = fixture("b");
    stageDraft(a, { ...draftFromProfile(a.profile), paused: true }, now);
    stageDraft(b, { ...draftFromProfile(b.profile), paused: true }, now);
    discardStaged(["a"]);
    expect(Object.keys(stagedSnapshot().entries)).toEqual(["b"]);
  });
});

describe("profile changes underneath a draft", () => {
  it("ignores and prunes a draft after a new revision", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    view.profile = { ...view.profile, revision: 5 };
    expect(stagedDraftFor(stagedSnapshot(), view, now)).toBeUndefined();
    pruneStaged([view], now);
    expect(stagedSnapshot().entries).toEqual({});
    expect(stagedSnapshot().cleared[view.cluster.id]).toContain("revision 5");
    dismissCleared(view.cluster.id);
    expect(stagedSnapshot().cleared).toEqual({});
  });

  it("never re-arms a diagnostic that ended after staging", () => {
    const view = runningDiagnostic(fixture(), 1);
    const draft = { ...draftFromProfile(view.profile, undefined, now) };
    stageDraft(view, { ...draft, paused: true }, now);
    expect(profileBase(view.profile, now)).toBe("4:diagnostic");
    const later = now + 2 * 60_000;
    expect(stagedDraftFor(stagedSnapshot(), view, later)).toBeUndefined();
    pruneStaged([view], later);
    expect(stagedSnapshot().cleared[view.cluster.id]).toContain(
      "diagnostic ended"
    );
  });

  it("leaves drafts alone for a snapshot older than they are", () => {
    const view = fixture();
    view.profile = { ...view.profile, revision: 6 };
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    // A cached scope still shows revision 5 while it refreshes.
    const cached = { ...view, profile: { ...view.profile, revision: 5 } };
    pruneStaged([cached], now);
    expect(stagedSnapshot().entries[view.cluster.id]).toBeDefined();
    expect(stagedSnapshot().cleared).toEqual({});
    expect(stagedDraftFor(stagedSnapshot(), view, now)?.paused).toBe(true);
  });

  it("leaves drafts alone while their request is in flight", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    markApplying([view.cluster.id]);
    view.profile = { ...view.profile, revision: 5 };
    pruneStaged([view], now);
    expect(stagedSnapshot().entries[view.cluster.id]).toBeDefined();
  });

  it("stays locked until the snapshot shows the applied revision", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    markApplying([view.cluster.id]);
    expect(awaitingSnapshot(stagedSnapshot(), view)).toBe(true);
    applySucceeded(view.cluster.id, { revision: 5, at: now });
    // Accepted, but the snapshot still shows revision 4.
    expect(awaitingSnapshot(stagedSnapshot(), view)).toBe(true);
    view.profile = { ...view.profile, revision: 5 };
    expect(awaitingSnapshot(stagedSnapshot(), view)).toBe(false);
  });

  it("says when the operator's own apply replaced later edits", () => {
    const view = fixture();
    markApplying([view.cluster.id]);
    applySucceeded(view.cluster.id, { revision: 5, at: now });
    // An edit staged against revision 4 before the snapshot caught up.
    stageDraft(view, { ...draftFromProfile(view.profile), name: "basic" }, now);
    pruneStaged([view], now);
    expect(stagedSnapshot().entries[view.cluster.id]).toBeDefined();
    view.profile = { ...view.profile, revision: 5 };
    pruneStaged([view], now);
    expect(stagedSnapshot().entries).toEqual({});
    expect(stagedSnapshot().cleared[view.cluster.id]).toContain(
      "Your applied changes (revision 5)"
    );
  });
});

describe("applying", () => {
  it("clears the draft and records the request on success", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    markApplying([view.cluster.id]);
    expect(stagedSnapshot().applying[view.cluster.id]).toBe(true);
    applySucceeded(view.cluster.id, { revision: 5, at: now });
    const state = stagedSnapshot();
    expect(state.entries).toEqual({});
    expect(state.applying).toEqual({});
    expect(state.requests[view.cluster.id]).toEqual({ revision: 5, at: now });
  });

  it("sends the staged profile and records the accepted revision", async () => {
    const view = fixture();
    const draft = { ...draftFromProfile(view.profile), paused: true };
    stageDraft(view, draft, now);
    markApplying([view.cluster.id]);
    const send = vi.fn().mockResolvedValue({ revision: 5 });
    await expect(
      applyStagedCluster({ view, draft }, send, () => now)
    ).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      view.cluster.id,
      expect.objectContaining({ name: "standard", paused: true, revision: 4 })
    );
    expect(stagedSnapshot().requests[view.cluster.id]).toEqual({
      revision: 5,
      at: now,
    });
    expect(stagedSnapshot().entries).toEqual({});
  });

  it("keeps the draft and the hub's reason when sending fails", async () => {
    const view = fixture();
    const draft = { ...draftFromProfile(view.profile), paused: true };
    stageDraft(view, draft, now);
    markApplying([view.cluster.id]);
    const send = vi.fn().mockRejectedValue(new Error("hub unavailable"));
    await expect(
      applyStagedCluster({ view, draft }, send, () => now)
    ).resolves.toBe(false);
    expect(stagedSnapshot().failures[view.cluster.id]).toContain(
      "hub unavailable"
    );
    expect(stagedSnapshot().applying).toEqual({});
    expect(stagedSnapshot().entries[view.cluster.id]).toBeDefined();
  });

  it("never re-arms a diagnostic that ended before the click landed", async () => {
    // Runs on n1 and ends at E = now + 60 s; staged at E - 60 s.
    const view = runningDiagnostic(fixture(), 1);
    const draft = {
      ...draftFromProfile(view.profile, undefined, now),
      paused: true,
    };
    expect(draft).toMatchObject({ name: "diagnostic", node: "n1" });
    stageDraft(view, draft, now);
    markApplying([view.cluster.id]);
    const send = vi.fn().mockResolvedValue({ revision: 5 });
    // The display clock still reads before E; the real clock is E + 3 s.
    await applyStagedCluster({ view, draft }, send, () => now + 63_000);
    expect(send).not.toHaveBeenCalled();
    expect(stagedSnapshot().applying).toEqual({});
    expect(stagedSnapshot().failures[view.cluster.id]).toContain(
      "diagnostic ended"
    );
  });

  it("keeps every node of a running diagnostic when applying other changes", async () => {
    const view = runningDiagnostic(fixture());
    view.profile = { ...view.profile, nodeUids: ["n1", "n2"] };
    // A deep link to the second node leaves the running diagnostic as is.
    const draft = {
      ...draftFor(stagedSnapshot(), view, now, "n2"),
      scope: "selected" as const,
      namespaces: ["shop"],
    };
    stageDraft(view, draft, now);
    const [cluster] = stagedClusters(stagedSnapshot(), [view], now);
    expect(cluster?.rows.map((row) => row.field)).toEqual(["namespaces"]);
    expect(cluster?.notes[0]).toContain(
      "The diagnostic on node-b, node-a keeps its current end time"
    );
    const send = vi.fn().mockResolvedValue({ revision: 5 });
    await applyStagedClusters([{ view, draft }], send, undefined, () => now);
    expect(send).toHaveBeenCalledWith(
      view.cluster.id,
      expect.objectContaining({
        name: "diagnostic",
        nodeUids: ["n1", "n2"],
        expiresAt: view.profile.expiresAt,
        namespaces: ["shop"],
      })
    );
  });

  it("refuses to keep a diagnostic end time about to lapse", async () => {
    const view = runningDiagnostic(fixture(), 1);
    const draft = {
      ...draftFromProfile(view.profile, undefined, now),
      paused: true,
    };
    stageDraft(view, draft, now);
    markApplying([view.cluster.id]);
    const send = vi.fn().mockResolvedValue({ revision: 5 });
    await applyStagedCluster({ view, draft }, send, () => now + 50_000);
    expect(send).not.toHaveBeenCalled();
    expect(stagedSnapshot().failures[view.cluster.id]).toContain(
      "ends in under 30 seconds"
    );
  });

  it("keeps the draft staged with the reason on failure", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    markApplying([view.cluster.id]);
    applyFailed(view.cluster.id, "The hub refused the request.");
    const [cluster] = stagedClusters(stagedSnapshot(), [view], now);
    expect(cluster?.failure).toBe("The hub refused the request.");
    expect(cluster?.applying).toBe(false);
    // Editing again clears the stale failure.
    stageDraft(view, { ...draftFromProfile(view.profile), name: "basic" }, now);
    expect(stagedSnapshot().failures).toEqual({});
  });
});

describe("staged rows", () => {
  it("shows current and new values per setting", () => {
    const view = fixture();
    const draft = {
      ...draftFromProfile(view.profile),
      name: "diagnostic" as const,
      node: "n2",
      scope: "selected" as const,
      namespaces: ["shop", "payments", "edge", "batch"],
      paused: true,
    };
    const rows = stagedRows(draft, view, now);
    expect(rows.map((row) => row.field)).toEqual([
      "profile",
      "namespaces",
      "paused",
    ]);
    expect(rows[0]).toMatchObject({
      label: "Collection profile",
      current: "Standard",
      next: "Diagnostic on node-a, for 9 min after applying, then Standard",
    });
    expect(rows[1]).toMatchObject({
      current: "All namespaces",
      next: "shop, payments, edge and 1 more",
    });
    expect(rows[2]).toMatchObject({ current: "Collecting", next: "Paused" });
  });

  it("describes a running diagnostic with its time left", () => {
    const view = runningDiagnostic(fixture());
    const draft = { ...draftFromProfile(view.profile, undefined, now) };
    const rows = stagedRows({ ...draft, extend: true }, view, now);
    expect(rows[0]?.current).toBe(
      "Diagnostic on node-b (5 min left), then Standard"
    );
    expect(rows[0]?.next).toContain("restarted for 9 min");
  });

  it("reverts one setting at a time", () => {
    const view = runningDiagnostic(fixture());
    const draft = {
      ...draftFromProfile(view.profile, undefined, now),
      name: "basic" as const,
      paused: true,
    };
    expect(stagedFields(draft, view.profile, now)).toEqual(
      new Set(["profile", "paused"])
    );
    const reverted = revertField(draft, view.profile, "profile", now);
    expect(reverted).toMatchObject({ name: "diagnostic", node: "n1" });
    expect(stagedFields(reverted, view.profile, now)).toEqual(
      new Set(["paused"])
    );
    const resumed = revertField(reverted, view.profile, "paused", now);
    expect(isPristine(resumed, view.profile, now)).toBe(true);
  });

  it("explains consequences without implying missing samples are zero", () => {
    const view = fixture();
    const diagnostic = {
      ...draftFromProfile(view.profile),
      name: "diagnostic" as const,
      node: "n1",
      paused: true,
    };
    const notes = stagedNotes(diagnostic, view, now);
    expect(notes[0]).toContain("expires 9 minutes after applying");
    expect(notes[1]).toContain("never zeros");
  });
});

describe("staged clusters", () => {
  it("counts changes, problems and pauses across clusters", () => {
    const a = fixture("a");
    const b = fixture("b");
    const c = fixture("c");
    stageDraft(
      a,
      { ...draftFromProfile(a.profile), name: "basic", paused: true },
      now
    );
    stageDraft(
      b,
      { ...draftFromProfile(b.profile), name: "diagnostic", node: "" },
      now
    );
    const clusters = stagedClusters(stagedSnapshot(), [a, b, c], now);
    expect(clusters.map((cluster) => cluster.view.cluster.id)).toEqual([
      "a",
      "b",
    ]);
    expect(stagedCount(clusters)).toBe(3);
    expect(clusters[1]?.problems[0]).toContain("Choose the node");
    expect(
      pausingClusters(clusters).map((item) => item.view.cluster.id)
    ).toEqual(["a"]);
  });

  it("shows requests while they settle, then hides them", () => {
    const view = fixture();
    markApplying([view.cluster.id]);
    expect(recentRequests(stagedSnapshot(), [view], now)).toEqual([{ view }]);
    applySucceeded(view.cluster.id, { revision: 5, at: now });
    view.profile = { ...view.profile, revision: 5, appliedRevision: 5 };
    const pending = recentRequests(stagedSnapshot(), [view], now + 1000);
    expect(pending[0]?.progress?.phase).toBe("waiting");
    acknowledge(view, 5, now + 1000);
    settleRequests([view], now + 1000);
    expect(
      recentRequests(stagedSnapshot(), [view], now + 1000)[0]?.progress?.phase
    ).toBe("complete");
    expect(recentRequests(stagedSnapshot(), [view], now + 61_000)).toEqual([]);
  });

  it("shows success for a while from when completion is seen", () => {
    const view = fixture();
    markApplying([view.cluster.id]);
    applySucceeded(view.cluster.id, { revision: 5, at: now });
    view.profile = { ...view.profile, revision: 5, appliedRevision: 5 };
    // The nodes acknowledge after the 60 s refresh.
    acknowledge(view, 5, now + 90_000);
    settleRequests([view], now + 90_000);
    expect(stagedSnapshot().requests[view.cluster.id]?.completedAt).toBe(
      now + 90_000
    );
    // A later pass keeps the first time it was seen.
    settleRequests([view], now + 95_000);
    expect(stagedSnapshot().requests[view.cluster.id]?.completedAt).toBe(
      now + 90_000
    );
    const shown = recentRequests(stagedSnapshot(), [view], now + 100_000);
    expect(shown[0]?.progress?.phase).toBe("complete");
    expect(shown[0]?.timedOut).toBeUndefined();
    acknowledge(view, 5, now + 149_000);
    expect(
      recentRequests(stagedSnapshot(), [view], now + 149_000)
    ).toHaveLength(1);
    acknowledge(view, 5, now + 150_000);
    expect(recentRequests(stagedSnapshot(), [view], now + 150_000)).toEqual([]);
  });

  it("flags unacknowledged requests after the patience window", () => {
    const view = fixture();
    markApplying([view.cluster.id]);
    applySucceeded(view.cluster.id, { revision: 5, at: now });
    view.profile = { ...view.profile, revision: 5, appliedRevision: 5 };
    // One of two nodes acknowledges.
    acknowledge(view, 5, now + 181_000, 1);
    const late = recentRequests(stagedSnapshot(), [view], now + 181_000);
    expect(late).toHaveLength(1);
    expect(late[0]?.progress?.phase).toBe("partial");
    expect(late[0]?.timedOut).toBe(true);
    // Still there much later, until dismissed.
    acknowledge(view, 5, now + 600_000, 1);
    expect(
      recentRequests(stagedSnapshot(), [view], now + 600_000)
    ).toHaveLength(1);
    dismissRequests([view.cluster.id]);
    expect(recentRequests(stagedSnapshot(), [view], now + 600_000)).toEqual([]);
    // Settings still knows the request.
    expect(stagedSnapshot().requests[view.cluster.id]?.revision).toBe(5);
  });

  it("drops a timed-out request once a newer revision replaces it", () => {
    const view = fixture();
    markApplying([view.cluster.id]);
    applySucceeded(view.cluster.id, { revision: 5, at: now });
    view.profile = { ...view.profile, revision: 6, appliedRevision: 6 };
    acknowledge(view, 6, now + 200_000, 1);
    expect(recentRequests(stagedSnapshot(), [view], now + 200_000)).toEqual([]);
  });
});

describe("cluster filter", () => {
  // Cluster a has one staged change, cluster b two.
  function stageBoth() {
    const a = fixture("a");
    const b = fixture("b");
    stageDraft(a, { ...draftFromProfile(a.profile), paused: true }, now);
    stageDraft(
      b,
      { ...draftFromProfile(b.profile), name: "basic", paused: true },
      now
    );
    return [a, b];
  }

  // What the Apply card covers for this URL state, by default on the canvas.
  function cardScope(
    views: ClusterView[],
    search: { cluster?: string; settingsCluster?: string; view?: string },
    time = now
  ) {
    return stagedScope(
      stagedSnapshot(),
      views,
      shownClusterIds(views, { view: "architecture", ...search }),
      time
    );
  }

  it("covers every cluster without a filter", () => {
    const views = stageBoth();
    const scope = cardScope(views, {});
    expect(scope.clusters.map((item) => item.view.cluster.id)).toEqual([
      "a",
      "b",
    ]);
    expect(scope.discard).toEqual(["a", "b"]);
    expect(scope.elsewhere).toEqual({ staged: 0, unconfirmed: 0 });
    // A Settings link without a filter adds nothing and repeats nothing.
    expect(
      cardScope(views, { view: "settings", settingsCluster: "b" }).discard
    ).toEqual(["a", "b"]);
  });

  it("applies the filtered cluster and leaves hidden drafts staged", async () => {
    const views = stageBoth();
    const scope = cardScope(views, { cluster: "a" });
    // Apply sends the card's clusters: the filtered one only.
    expect(scope.clusters.map((item) => item.view.cluster.id)).toEqual(["a"]);
    expect(scope.elsewhere).toEqual({ staged: 2, unconfirmed: 0 });
    const send = vi.fn().mockResolvedValue({ revision: 5 });
    const accepted = vi.fn();
    await applyStagedClusters(scope.clusters, send, accepted, () => now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("a", expect.anything());
    expect(accepted).toHaveBeenCalledTimes(1);
    const state = stagedSnapshot();
    expect(state.applying).toEqual({});
    expect(Object.keys(state.entries)).toEqual(["b"]);
    expect(Object.keys(state.requests)).toEqual(["a"]);
  });

  it("discards the filtered cluster and leaves hidden drafts staged", () => {
    const views = stageBoth();
    const scope = cardScope(views, { cluster: "a" });
    // Discard all removes the clusters the card covers: the filtered one.
    expect(scope.discard).toEqual(["a"]);
    discardStaged(scope.discard);
    expect(Object.keys(stagedSnapshot().entries)).toEqual(["b"]);
    // Nothing left to show here, but the hidden drafts are still counted.
    expect(cardScope(views, { cluster: "a" })).toMatchObject({
      clusters: [],
      elsewhere: { staged: 2, unconfirmed: 0 },
    });
  });

  it("counts every draft as hidden for a cluster outside the scope", () => {
    const views = stageBoth();
    expect(cardScope(views, { cluster: "gone" })).toEqual({
      clusters: [],
      discard: [],
      elsewhere: { staged: 3, unconfirmed: 0 },
      recent: [],
    });
  });

  it("follows the filtered cluster's requests and counts hidden unconfirmed ones", () => {
    const a = fixture("a");
    const b = fixture("b");
    for (const view of [a, b]) {
      markApplying([view.cluster.id]);
      applySucceeded(view.cluster.id, { revision: 5, at: now });
      view.profile = { ...view.profile, revision: 5, appliedRevision: 5 };
      // One of two nodes acknowledges, past the patience window.
      acknowledge(view, 5, now + 181_000, 1);
    }
    const scope = cardScope([a, b], { cluster: "a" }, now + 181_000);
    expect(scope.recent.map((item) => item.view.cluster.id)).toEqual(["a"]);
    // The unconfirmed request for b is out of sight, never silently dropped.
    expect(scope.elsewhere).toEqual({ staged: 0, unconfirmed: 1 });
    dismissRequests(["b"]);
    expect(
      cardScope([a, b], { cluster: "a" }, now + 181_000).elsewhere
    ).toEqual({ staged: 0, unconfirmed: 0 });
  });
});

describe("cluster opened from a Settings link", () => {
  // The top bar filter shows a; Settings was opened for b through a link
  // while the filter hides it. Each cluster has one staged change; b's is a
  // Diagnostic.
  function stageThree() {
    const views = ["a", "b", "c"].map((id) => fixture(id));
    const [a, b, c] = views as [ClusterView, ClusterView, ClusterView];
    stageDraft(a, { ...draftFromProfile(a.profile), paused: true }, now);
    stageDraft(
      b,
      { ...draftFromProfile(b.profile), name: "diagnostic", node: "n1" },
      now
    );
    stageDraft(c, { ...draftFromProfile(c.profile), paused: true }, now);
    return views;
  }

  const linked = { view: "settings", cluster: "a", settingsCluster: "b" };

  function linkedScope(views: ClusterView[], view = "settings", time = now) {
    return stagedScope(
      stagedSnapshot(),
      views,
      shownClusterIds(views, { ...linked, view }),
      time
    );
  }

  it("lists, applies and follows the linked cluster beside the filtered one", async () => {
    const views = stageThree();
    expect(shownClusterIds(views, linked)).toEqual(["a", "b"]);
    const scope = linkedScope(views);
    // The card agrees with b's section pill instead of calling it elsewhere.
    expect(scope.clusters.map((item) => item.view.cluster.id)).toEqual([
      "a",
      "b",
    ]);
    expect(scope.elsewhere).toEqual({ staged: 1, unconfirmed: 0 });
    const send = vi.fn().mockResolvedValue({ revision: 5 });
    await applyStagedClusters(scope.clusters, send, undefined, () => now);
    expect(send.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b"]);
    // The hidden cluster's draft is never sent.
    expect(Object.keys(stagedSnapshot().entries)).toEqual(["c"]);
    // Both requests are followed on the card, not counted as elsewhere.
    const after = linkedScope(views);
    expect(after.recent.map((item) => item.view.cluster.id)).toEqual([
      "a",
      "b",
    ]);
    expect(after.elsewhere).toEqual({ staged: 1, unconfirmed: 0 });
  });

  it("discards the linked cluster with the filtered one, never the hidden", () => {
    const views = stageThree();
    const scope = linkedScope(views);
    expect(scope.discard).toEqual(["a", "b"]);
    discardStaged(scope.discard);
    expect(Object.keys(stagedSnapshot().entries)).toEqual(["c"]);
    expect(linkedScope(views)).toMatchObject({
      clusters: [],
      elsewhere: { staged: 1, unconfirmed: 0 },
    });
  });

  it("counts the linked cluster as elsewhere off Settings", () => {
    const views = stageThree();
    for (const view of ["architecture", "observability"]) {
      expect(shownClusterIds(views, { ...linked, view })).toEqual(["a"]);
      const scope = linkedScope(views, view);
      expect(scope.clusters.map((item) => item.view.cluster.id)).toEqual(["a"]);
      expect(scope.discard).toEqual(["a"]);
      expect(scope.elsewhere).toEqual({ staged: 2, unconfirmed: 0 });
    }
  });

  it("only adds a linked cluster that is in the workspace scope", () => {
    const views = stageThree();
    expect(
      shownClusterIds(views, { ...linked, settingsCluster: "gone" })
    ).toEqual(["a"]);
    // A filter outside the scope leaves the linked cluster alone on the card,
    // as Settings lists it alone.
    expect(shownClusterIds(views, { ...linked, cluster: "gone" })).toEqual([
      "b",
    ]);
  });
});

describe("settings tab badge", () => {
  it("counts live changes and only says drafts wait while frozen", () => {
    const a = fixture("a");
    const b = fixture("b");
    expect(stagedBadge(stagedSnapshot(), "synthetic", [a, b], now, true)).toBe(
      undefined
    );
    stageDraft(
      a,
      { ...draftFromProfile(a.profile), name: "basic", paused: true },
      now
    );
    expect(stagedBadge(stagedSnapshot(), "synthetic", [a, b], now, true)).toBe(
      2
    );
    // Before the display clock starts nothing is compared.
    expect(
      stagedBadge(stagedSnapshot(), "synthetic", [a, b], 0, true)
    ).toBeUndefined();
    // Nor before the live snapshot loads.
    expect(
      stagedBadge(stagedSnapshot(), "synthetic", undefined, now, true)
    ).toBeUndefined();
    // A frozen snapshot's past profile cannot be compared with the draft.
    // With no live snapshot cached, the workspace recorded at staging decides.
    expect(
      stagedBadge(stagedSnapshot(), "synthetic", undefined, now, false)
    ).toBe("waiting");
    expect(
      stagedBadge(stagedSnapshot(), "other", undefined, now, false)
    ).toBeUndefined();
    // A cached live snapshot the draft still applies to: still no count.
    expect(stagedBadge(stagedSnapshot(), "synthetic", [a, b], now, false)).toBe(
      "waiting"
    );
    discardStaged(["a"]);
    expect(
      stagedBadge(stagedSnapshot(), "synthetic", undefined, now, false)
    ).toBeUndefined();
  });
});

describe("frozen staged rule", () => {
  // A frozen view asks twice whether drafts wait, for the Settings tab badge
  // and for the Apply card; both must give the same answer.
  function frozenAnswer(cached: ClusterView[] | undefined, time = now) {
    const current = stagedSnapshot();
    const waiting = stagedWaiting(current, "synthetic", cached, time);
    const badge = stagedBadge(current, "synthetic", cached, time, false);
    expect(badge === "waiting").toBe(waiting);
    return waiting;
  }

  it("waits for drafts that still apply to the cached live profile", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    expect(frozenAnswer([view])).toBe(true);
    expect(frozenAnswer(undefined)).toBe(true);
  });

  it("drops a draft whose base the cached live profile has moved past", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    // Another operator applied revision 5 before the view froze. The entry is
    // still recorded for the workspace, but it can no longer apply.
    view.profile = { ...view.profile, revision: 5, appliedRevision: 5 };
    expect(stagedInScope(stagedSnapshot(), "synthetic")).toBe(true);
    expect(frozenAnswer([view])).toBe(false);
  });

  it("drops a draft staged while a diagnostic ran that has since ended", () => {
    const view = runningDiagnostic(fixture(), 1);
    stageDraft(
      view,
      { ...draftFromProfile(view.profile, undefined, now), paused: true },
      now
    );
    expect(frozenAnswer([view])).toBe(true);
    // Same revision, but the effective profile is no longer the diagnostic.
    expect(frozenAnswer([view], now + 120_000)).toBe(false);
  });

  it("falls back to the recorded workspace only when nothing can be judged", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    view.profile = { ...view.profile, revision: 5, appliedRevision: 5 };
    expect(frozenAnswer(undefined)).toBe(true);
    // Before the display clock starts the cache cannot be judged either.
    expect(frozenAnswer([view], 0)).toBe(true);
    expect(stagedWaiting(stagedSnapshot(), "other", undefined, now)).toBe(
      false
    );
  });
});

describe("unload guard", () => {
  type Listener = (event: BeforeUnloadEvent) => void;

  // Records beforeunload listeners like a window would.
  function fakeWindow() {
    const listeners = new Set<Listener>();
    return {
      listeners,
      addEventListener: vi.fn((_type: "beforeunload", listener: Listener) => {
        listeners.add(listener);
      }),
      removeEventListener: vi.fn(
        (_type: "beforeunload", listener: Listener) => {
          listeners.delete(listener);
        }
      ),
    };
  }

  it("asks before unloading only while drafts or applies wait", () => {
    const target = fakeWindow();
    const stop = guardUnload(target);
    expect(target.listeners.size).toBe(0);
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    expect(target.listeners.size).toBe(1);
    // A second draft keeps the one listener.
    const other = fixture("b");
    stageDraft(
      other,
      { ...draftFromProfile(other.profile), paused: true },
      now
    );
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    const event = { preventDefault: vi.fn(), returnValue: undefined };
    for (const listener of target.listeners) {
      listener(event as unknown as BeforeUnloadEvent);
    }
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    discardStaged([view.cluster.id, other.cluster.id]);
    expect(target.listeners.size).toBe(0);
    // An apply on its way to the hub is guarded with no draft left.
    markApplying([view.cluster.id]);
    expect(target.listeners.size).toBe(1);
    applySucceeded(view.cluster.id, { revision: 5, at: now });
    expect(target.listeners.size).toBe(0);
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    expect(target.listeners.size).toBe(1);
    stop();
    expect(target.listeners.size).toBe(0);
    discardStaged([view.cluster.id]);
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    expect(target.listeners.size).toBe(0);
  });

  it("never asks for drafts the Apply card and badge do not count", () => {
    const target = fakeWindow();
    const stop = guardUnload(target);
    // A choice still being built has nothing to lose.
    const view = fixture();
    stageDraft(
      view,
      { ...draftFromProfile(view.profile), scope: "selected" },
      now
    );
    expect(
      stagedBadge(stagedSnapshot(), "synthetic", [view], now, true)
    ).toBeUndefined();
    expect(target.listeners.size).toBe(0);
    // A staged change arms it; once the profile changes underneath, the
    // pruned draft disarms it again.
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    expect(target.listeners.size).toBe(1);
    view.profile = { ...view.profile, revision: 5 };
    expect(
      stagedBadge(stagedSnapshot(), "synthetic", [view], now, true)
    ).toBeUndefined();
    pruneStaged([view], now);
    expect(target.listeners.size).toBe(0);
    stop();
  });
});

// Fresh heartbeats at `time`, with the first `count` nodes on `revision`.
function acknowledge(
  view: ClusterView,
  revision: number,
  time: number,
  count = Number.POSITIVE_INFINITY
) {
  const seen = new Date(time - 5000).toISOString();
  view.cluster = { ...view.cluster, heartbeatAt: seen };
  view.heartbeat = {
    ...view.heartbeat,
    appliedRevision: revision,
    nodes: (view.heartbeat.nodes ?? []).map((node, index) => ({
      ...node,
      seenAt: seen,
      appliedRevision: index < count ? revision : node.appliedRevision,
    })),
  };
}
