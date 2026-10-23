import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { summarize } from "../lib/infrastructure";
import { PodsTab } from "./panel-pods";

// Synthetic node and pods only: a crash-looping pod, a ready one, and a Job
// pod that was OOM-killed, failed and was retained.
const now = Date.parse("2026-10-22T12:00:00Z");
const at = new Date(now - 30_000).toISOString();
const server = {
  uid: "synthetic-node",
  kind: "Node",
  name: "synthetic-node",
  status: "True",
} as Entity;

function pod(name: string, status: string, ready: number): Entity {
  return {
    uid: name,
    kind: "Pod",
    name,
    namespace: "synthetic",
    nodeUid: server.uid,
    status,
    ready,
    desired: 1,
  } as Entity;
}

const view = {
  cluster: {
    id: "synthetic",
    name: "synthetic-cluster",
    workspaceId: "synthetic-workspace",
    environment: "test",
    revoked: false,
    heartbeatAt: at,
  },
  inventory: {
    entities: [
      server,
      pod("synthetic-crash", "CrashLoopBackOff", 0),
      pod("synthetic-web", "Running", 1),
      pod("synthetic-report", "Failed / OOM observed", 0),
    ],
    edges: [],
    sourceTime: at,
    capabilities: [],
  },
  metrics: [],
  profile: {
    name: "standard",
    revision: 1,
    appliedRevision: 1,
    paused: false,
    nodeUids: [],
    namespaces: [],
  },
  heartbeat: {
    version: "test",
    appliedRevision: 1,
    queueBytes: 0,
    dropped: 0,
    rejectedPoints: 0,
    capabilities: [],
    outcome: "",
  },
} as unknown as ClusterView;

const warning = "bg-warning/10";

// Each pod's row, found by the pod's name.
function rows() {
  const markup = renderToStaticMarkup(
    createElement(
      DisplayProvider,
      null,
      createElement(PodsTab, {
        view,
        entity: server,
        summary: summarize(view, server, now),
        coverage: { active: 2, finished: 1, measured: 0 },
        now,
        stale: false,
        onInspect: () => undefined,
      })
    )
  );
  const items = markup.split("<li>").slice(1);
  return (name: string) => {
    const row = items.find((item) => item.includes(`>${name}<`));
    if (!row) {
      throw new Error(`no row for ${name}`);
    }
    return row;
  };
}

describe("inspector Pods tab", () => {
  it("shows a finished failed pod as history, without a warning", () => {
    const row = rows();
    const finished = row("synthetic-report");
    expect(finished).toContain("Failed / OOM observed");
    expect(finished).toContain("Finished · not reporting");
    expect(finished).not.toContain(warning);
    // A live problem beside it keeps its warning.
    expect(row("synthetic-crash")).toContain(warning);
    expect(row("synthetic-web")).not.toContain(warning);
  });
});
