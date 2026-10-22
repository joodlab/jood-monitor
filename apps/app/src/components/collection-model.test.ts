import type { ClusterView } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { profileSchema } from "../schemas/clusters";
import {
  ackPatienceMs,
  ackPollDelay,
  activeDiagnostic,
  awaitingAcknowledgment,
  capabilityLabel,
  deliveryHealth,
  draftChanges,
  draftFieldChanges,
  draftFieldProblems,
  draftFromProfile,
  draftProblems,
  effectiveProfileName,
  formatBytes,
  knownNamespaces,
  latestPendingRequest,
  namespaceLimit,
  namespaceProblem,
  nodeAcknowledgments,
  nodeNamer,
  observationFreshness,
  profileRequest,
  progressSummary,
  progressText,
  requestProgress,
  returnProfile,
  validationText,
} from "./collection-model";

const now = Date.parse("2026-10-22T10:00:00.000Z");
const at = new Date(now - 10_000).toISOString();

function fixture(): ClusterView {
  return {
    cluster: {
      id: "synthetic-a",
      name: "Synthetic A",
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
        {
          uid: "p1",
          name: "api-1",
          kind: "Pod",
          namespace: "payments",
          status: "Running",
        },
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
      namespaces: ["legacy"],
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
          appliedRevision: 3,
          profile: "basic",
          paused: false,
          dropped: 2,
        },
      ],
    },
  } as ClusterView;
}

describe("profile drafts", () => {
  it("starts unchanged and lists each requested change", () => {
    const view = fixture();
    const draft = draftFromProfile(view.profile);
    expect(draft).toMatchObject({ name: "standard", scope: "selected" });
    expect(draftChanges(draft, view.profile)).toEqual([]);
    const changed = {
      ...draft,
      name: "diagnostic" as const,
      node: "n2",
      scope: "all" as const,
      paused: true,
    };
    const changes = draftChanges(changed, view.profile, () => "node-a");
    expect(changes).toHaveLength(3);
    expect(changes[0]).toContain(
      "diagnostic on node-a, then return to Standard"
    );
    expect(changes[1]).toContain("all namespaces");
    expect(changes[2]).toBe("Pause new samples");
  });

  it("treats namespace order and duplicates as unchanged", () => {
    const view = fixture();
    view.profile.namespaces = ["a", "b"];
    const draft = {
      ...draftFromProfile(view.profile),
      namespaces: ["b", "a", "a"],
    };
    expect(draftChanges(draft, view.profile)).toEqual([]);
  });

  it("blocks diagnostics without a node and over-limit namespaces", () => {
    const view = fixture();
    const nodes = view.inventory.entities.filter((e) => e.kind === "Node");
    const draft = {
      ...draftFromProfile(view.profile),
      name: "diagnostic" as const,
    };
    expect(draftProblems(draft, nodes)[0]).toContain("Choose the node");
    expect(draftProblems(draft, [])[0]).toContain("need a node");
    const many = Array.from(
      { length: namespaceLimit + 1 },
      (_, i) => `ns-${i}`
    );
    const tooMany = { ...draftFromProfile(view.profile), namespaces: many };
    expect(draftProblems(tooMany, nodes)[0]).toContain("at most 32");
    const empty = { ...draftFromProfile(view.profile), namespaces: [] };
    expect(draftProblems(empty, nodes)[0]).toContain("at least one namespace");
    expect(namespaceProblem("a b", [])).toContain("one namespace at a time");
    expect(namespaceProblem("x", many.slice(0, 32))).toContain("At most 32");
    expect(namespaceProblem("shop", [])).toBeUndefined();
  });

  it("builds requests the hub schema accepts", () => {
    const view = fixture();
    const draft = {
      ...draftFromProfile(view.profile),
      name: "diagnostic" as const,
      node: "n1",
    };
    const request = profileRequest(draft, view.profile, now);
    const parsed = profileSchema.parse(request);
    expect(parsed.nodeUids).toEqual(["n1"]);
    expect(Date.parse(parsed.expiresAt ?? "") - now).toBe(9 * 60_000);
    expect(parsed.revision).toBe(4);
    const basic = profileRequest(
      { ...draft, name: "basic", scope: "all" },
      view.profile,
      now
    );
    expect(basic).not.toHaveProperty("expiresAt");
    expect(basic.nodeUids).toEqual([]);
    expect(basic.namespaces).toEqual([]);
  });
});

describe("diagnostics", () => {
  it("reports the running diagnostic and where it returns", () => {
    const view = fixture();
    expect(activeDiagnostic(view.profile, now)).toBeUndefined();
    view.profile = {
      ...view.profile,
      name: "diagnostic",
      nodeUids: ["n1"],
      returnProfile: "standard",
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
    };
    expect(activeDiagnostic(view.profile, now)).toMatchObject({
      nodeUids: ["n1"],
      returnTo: "standard",
    });
    expect(activeDiagnostic(view.profile, now + 6 * 60_000)).toBeUndefined();
    expect(returnProfile({ ...view.profile, returnProfile: undefined })).toBe(
      "basic"
    );
  });

  it("keeps a running diagnostic's expiry unless the draft restarts it", () => {
    const view = fixture();
    const expiresAt = new Date(now + 60_000).toISOString();
    view.profile = {
      ...view.profile,
      name: "diagnostic",
      nodeUids: ["n1"],
      returnProfile: "standard",
      expiresAt,
    };
    const draft = draftFromProfile(view.profile, undefined, now);
    expect(draft).toMatchObject({
      name: "diagnostic",
      node: "n1",
      extend: false,
    });
    const edited = { ...draft, scope: "all" as const };
    expect(draftChanges(edited, view.profile, undefined, now)).toEqual([
      "Collect pod metrics in all namespaces instead of 1 selected namespace",
    ]);
    const kept = profileSchema.parse(profileRequest(edited, view.profile, now));
    expect(kept.expiresAt).toBe(expiresAt);
    const restarted = { ...edited, extend: true };
    expect(
      draftChanges(restarted, view.profile, () => "node-b", now)[0]
    ).toContain("Restart the diagnostic on node-b for 9 minutes");
    const renewed = profileRequest(restarted, view.profile, now);
    expect(Date.parse(renewed.expiresAt ?? "") - now).toBe(9 * 60_000);
    const moved = { ...draft, node: "n2" };
    expect(draftChanges(moved, view.profile, () => "node-a", now)[0]).toBe(
      "Run a 9-minute diagnostic on node-a, then return to Standard"
    );
    const fresh = profileRequest(moved, view.profile, now);
    expect(Date.parse(fresh.expiresAt ?? "") - now).toBe(9 * 60_000);
    const nodes = view.inventory.entities.filter((e) => e.kind === "Node");
    expect(draftProblems(edited, nodes, view.profile, now)).toEqual([]);
    const ending = now + 60_000 - 10_000;
    expect(draftProblems(edited, nodes, view.profile, ending)[0]).toContain(
      "ends in under 30 seconds"
    );
    expect(draftProblems(restarted, nodes, view.profile, ending)).toEqual([]);
  });

  it("treats an expired diagnostic as already returned", () => {
    const view = fixture();
    view.profile = {
      ...view.profile,
      name: "diagnostic",
      nodeUids: ["n1"],
      returnProfile: "standard",
      expiresAt: new Date(now - 1000).toISOString(),
    };
    expect(effectiveProfileName(view.profile, now)).toBe("standard");
    const draft = draftFromProfile(view.profile, undefined, now);
    expect(draft.name).toBe("standard");
    expect(draftChanges(draft, view.profile, undefined, now)).toEqual([]);
    // A draft still holding the old diagnostic is listed as a new run.
    const stale = { ...draft, name: "diagnostic" as const, node: "n1" };
    expect(draftChanges(stale, view.profile, undefined, now)[0]).toContain(
      "Run a 9-minute diagnostic on n1"
    );
    const request = profileRequest(stale, view.profile, now);
    expect(Date.parse(request.expiresAt ?? "") - now).toBe(9 * 60_000);
  });
});

describe("delivery health", () => {
  it("presents counters as current only with a fresh heartbeat", () => {
    const view = fixture();
    const fresh = deliveryHealth(view, now);
    expect(fresh.note).toBeUndefined();
    expect(
      fresh.stats.map((stat) => [stat.term, stat.value, stat.warn])
    ).toEqual([
      ["Buffered on agent", "0 B", false],
      ["Dropped", "0", false],
      ["Rejected points", "0", false],
    ]);
    const stale = deliveryHealth(view, now + 10 * 60_000);
    expect(stale.stats.find((stat) => stat.term === "Dropped")).toMatchObject({
      value: "0 (last reported)",
      warn: true,
    });
    expect(
      stale.stats.every((stat) => stat.value.endsWith("(last reported)"))
    ).toBe(true);
    expect(stale.note).toContain("stale");
  });

  it("flags non-zero counters and never shows missing heartbeats as zero", () => {
    const view = fixture();
    view.heartbeat = { ...view.heartbeat, queueBytes: 2048, dropped: 3 };
    expect(
      deliveryHealth(view, now).stats.map((stat) => [stat.value, stat.warn])
    ).toEqual([
      ["2.0 KiB", true],
      ["3", true],
      ["0", false],
    ]);
    for (const heartbeatAt of [null, "0001-01-01T00:00:00Z"]) {
      view.cluster = { ...view.cluster, heartbeatAt };
      const missing = deliveryHealth(view, now);
      expect(missing.note).toBeUndefined();
      expect(
        missing.stats.every(
          (stat) => stat.value === "Not reported" && !stat.warn
        )
      ).toBe(true);
    }
  });
});

describe("acknowledgments", () => {
  it("lists namespaces from inventory and configuration", () => {
    expect(knownNamespaces(fixture())).toEqual(["legacy", "payments", "shop"]);
  });

  it("maps node outcomes to statuses", () => {
    const rows = nodeAcknowledgments(fixture(), now);
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["node-a", "pending"],
      ["node-b", "acknowledged"],
    ]);
    const stale = nodeAcknowledgments(fixture(), now + 10 * 60_000);
    expect(stale.every((row) => row.status === "unavailable")).toBe(true);
  });

  it("tracks a requested revision through to completion", () => {
    const view = fixture();
    expect(requestProgress(view, 5, now).phase).toBe("syncing");
    expect(requestProgress(view, 3, now).phase).toBe("superseded");
    expect(requestProgress(view, 4, now)).toMatchObject({
      phase: "partial",
      acknowledged: 1,
      pending: 1,
      total: 2,
      observerReceived: true,
    });
    const nodes = view.heartbeat.nodes ?? [];
    nodes[1] = { ...nodes[1], appliedRevision: 4, profile: "standard" };
    expect(requestProgress(view, 4, now).phase).toBe("complete");
    expect(requestProgress(view, 4, now + 10 * 60_000).phase).toBe(
      "observer-stale"
    );
  });

  it("backs off acknowledgment refreshes within the patience window", () => {
    const delays: number[] = [];
    let elapsed = 0;
    let delay = ackPollDelay(elapsed);
    while (delay !== undefined) {
      delays.push(delay);
      elapsed += delay;
      delay = ackPollDelay(elapsed);
    }
    expect(delays).toEqual([
      10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000,
    ]);
    expect(elapsed).toBeLessThanOrEqual(ackPatienceMs);
    expect(ackPollDelay(ackPatienceMs)).toBeUndefined();
  });

  it("keeps the refresh schedule across remounts", () => {
    // A poller mounted 12 s after the request waits for the 30 s mark, not
    // another 10 s from its own start.
    expect(ackPollDelay(12_000)).toBe(18_000);
    // A tick that fires slightly early does not repeat its mark.
    expect(ackPollDelay(29_800)).toBe(30_200);
    expect(ackPollDelay(ackPatienceMs - 1000)).toBe(1000);
    expect(ackPollDelay(ackPatienceMs - 200)).toBeUndefined();
  });

  it("keeps refreshing only while a request can still be acknowledged", () => {
    const view = fixture();
    const request = { revision: 4, at: now - 5000 };
    expect(awaitingAcknowledgment(view, undefined, now)).toBe(false);
    expect(awaitingAcknowledgment(view, request, now)).toBe(true);
    expect(awaitingAcknowledgment(view, { ...request, revision: 5 }, now)).toBe(
      true
    );
    expect(awaitingAcknowledgment(view, { ...request, revision: 3 }, now)).toBe(
      false
    );
    expect(
      awaitingAcknowledgment(view, { ...request, at: now - ackPatienceMs }, now)
    ).toBe(false);
    const nodes = view.heartbeat.nodes ?? [];
    nodes[1] = { ...nodes[1], appliedRevision: 4, profile: "standard" };
    expect(awaitingAcknowledgment(view, request, now)).toBe(false);
    const empty = fixture();
    empty.inventory = {
      ...empty.inventory,
      entities: empty.inventory.entities.filter(
        (entity) => entity.kind !== "Node"
      ),
    };
    expect(awaitingAcknowledgment(empty, request, now)).toBe(false);
  });

  it("drives one page-wide poller from the latest pending request", () => {
    const first = fixture();
    const second = fixture();
    second.cluster = { ...second.cluster, id: "synthetic-b" };
    const views = [first, second];
    expect(latestPendingRequest(views, {}, now)).toBeUndefined();
    expect(
      latestPendingRequest(
        views,
        {
          "synthetic-a": { revision: 4, at: now - 60_000 },
          "synthetic-b": { revision: 4, at: now - 20_000 },
        },
        now
      )
    ).toBe(now - 20_000);
    expect(
      latestPendingRequest(
        views,
        {
          "synthetic-a": { revision: 4, at: now - 60_000 },
          "synthetic-b": { revision: 3, at: now - 20_000 },
          "not-displayed": { revision: 4, at: now - 1000 },
        },
        now
      )
    ).toBe(now - 60_000);
  });

  it("judges inventory against its reconciliation cadence", () => {
    const twoMinutes = new Date(now - 120_000).toISOString();
    const fiveMinutes = new Date(now - 300_000).toISOString();
    expect(observationFreshness("heartbeat", twoMinutes, now)).toBe("stale");
    expect(observationFreshness("inventory", twoMinutes, now)).toBe("fresh");
    expect(observationFreshness("inventory", fiveMinutes, now)).toBe("stale");
    for (const kind of ["heartbeat", "inventory"] as const) {
      expect(observationFreshness(kind, null, now)).toBe("unknown");
      expect(observationFreshness(kind, "0001-01-01T00:00:00Z", now)).toBe(
        "unknown"
      );
    }
  });

  it("formats agent buffers in binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(8 * 1024 ** 2)).toBe("8.0 MiB");
  });
});

describe("staged change support", () => {
  it("reports each change with the setting it belongs to", () => {
    const view = fixture();
    const draft = {
      ...draftFromProfile(view.profile),
      name: "basic" as const,
      scope: "all" as const,
    };
    expect(
      draftFieldChanges(draft, view.profile).map((change) => change.field)
    ).toEqual(["profile", "namespaces"]);
    expect(draftChanges(draft, view.profile)).toEqual(
      draftFieldChanges(draft, view.profile).map((change) => change.summary)
    );
  });

  it("splits blocking problems by setting", () => {
    const view = fixture();
    const nodes = view.inventory.entities.filter((e) => e.kind === "Node");
    const draft = {
      ...draftFromProfile(view.profile),
      name: "diagnostic" as const,
      namespaces: [],
    };
    const problems = draftFieldProblems(draft, nodes, view.profile, now);
    expect(problems.profile[0]).toContain("Choose the node");
    expect(problems.namespaces[0]).toContain("at least one namespace");
    expect(draftProblems(draft, nodes, view.profile, now)).toEqual([
      ...problems.profile,
      ...problems.namespaces,
    ]);
  });

  it("names nodes, sources and schema errors for people", () => {
    const view = fixture();
    expect(nodeNamer(view)("n2")).toBe("node-a");
    expect(nodeNamer(view)("gone")).toBe("gone");
    expect(capabilityLabel("metrics_api")).toBe("Metrics API");
    expect(capabilityLabel("custom")).toBe("custom");
    const parsed = profileSchema.safeParse({ name: "nope" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(validationText(parsed.error)).toContain(
        "The request is invalid: "
      );
    }
  });

  it("summarises acknowledgment progress briefly and in full", () => {
    const view = fixture();
    const waiting = requestProgress(view, 4, now);
    expect(waiting.phase).toBe("partial");
    expect(progressSummary(waiting)).toBe("1 of 2 nodes acknowledged");
    expect(progressText(waiting, 4)).toContain("1 of 2 nodes acknowledged");
    const syncing = requestProgress(view, 5, now);
    expect(progressSummary(syncing)).toBe("Sent, loading the latest status…");
    expect(progressText(syncing, 5)).toContain("Loading the latest status");
    const stale = requestProgress(view, 4, now + 10 * 60_000);
    expect(progressSummary(stale)).toContain("heartbeat stale");
  });
});
