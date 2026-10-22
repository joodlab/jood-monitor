import type { ClusterView } from "@jood-monitor/api-client";
import { afterEach, describe, expect, it } from "vitest";
import { draftFromProfile } from "../components/collection-model";
import {
  applyFailed,
  applySucceeded,
  discardStaged,
  dismissCleared,
  draftFor,
  isPristine,
  markApplying,
  pausingClusters,
  profileBase,
  pruneStaged,
  recentRequests,
  resetStaged,
  revertField,
  stageDraft,
  stagedClusters,
  stagedCount,
  stagedDraftFor,
  stagedFields,
  stagedNotes,
  stagedRows,
  stagedSnapshot,
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
      draft,
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
  });

  it("preselects a requested node only when it is in the inventory", () => {
    const view = fixture();
    expect(draftFor(stagedSnapshot(), view, now, "n2").node).toBe("n2");
    expect(draftFor(stagedSnapshot(), view, now, "gone").node).toBe("");
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

  it("leaves drafts alone while their request is in flight", () => {
    const view = fixture();
    stageDraft(view, { ...draftFromProfile(view.profile), paused: true }, now);
    markApplying([view.cluster.id]);
    view.profile = { ...view.profile, revision: 5 };
    pruneStaged([view], now);
    expect(stagedSnapshot().entries[view.cluster.id]).toBeDefined();
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
    const nodes = view.heartbeat.nodes ?? [];
    view.heartbeat = {
      ...view.heartbeat,
      appliedRevision: 5,
      nodes: nodes.map((node) => ({ ...node, appliedRevision: 5 })),
    };
    expect(
      recentRequests(stagedSnapshot(), [view], now + 1000)[0]?.progress?.phase
    ).toBe("complete");
    expect(recentRequests(stagedSnapshot(), [view], now + 61_000)).toEqual([]);
  });
});
