import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { summarize } from "../lib/infrastructure";
import { PodsTab } from "./panel-pods";

// Synthetic node and pods only: a crash-looping pod, ready ones with
// configured requests, one from an observer that reports no requests, and a
// Job pod that was OOM-killed, failed and was retained.
const now = Date.parse("2026-10-22T12:00:00Z");
const at = new Date(now - 30_000).toISOString();
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const server = {
  uid: "synthetic-node",
  kind: "Node",
  name: "synthetic-node",
  status: "True",
  allocatableCpu: 4,
  allocatableMemory: 8 * GiB,
} as Entity;

function pod(
  name: string,
  status: string,
  ready: number,
  extra: Partial<Entity> = {}
): Entity {
  return {
    uid: name,
    kind: "Pod",
    name,
    namespace: "synthetic",
    nodeUid: server.uid,
    status,
    ready,
    desired: 1,
    ...extra,
  } as Entity;
}

const workload = {
  uid: "synthetic-deployment",
  kind: "Deployment",
  name: "synthetic-web",
  namespace: "synthetic",
  status: "Observed",
} as Entity;

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
      workload,
      pod("synthetic-crash", "CrashLoopBackOff", 0, {
        requestedCpu: 0.1,
        requestedMemory: 128 * MiB,
      }),
      pod("synthetic-web", "Running", 1, {
        requestedCpu: 0.5,
        requestedMemory: 512 * MiB,
      }),
      pod("synthetic-api", "Running", 1, {
        requestedCpu: 1,
        requestedMemory: 2 * GiB,
      }),
      pod("synthetic-cache", "Running", 1, {
        requestedCpu: 0.25,
        requestedMemory: 512 * MiB,
      }),
      pod("synthetic-older", "Running", 1),
      pod("synthetic-report", "Failed / OOM observed", 0, {
        requestedMemory: 4 * GiB,
      }),
    ],
    edges: [
      {
        source: "synthetic-web",
        target: workload.uid,
        relation: "owned_by",
        evidence: "Synthetic fixture relationship",
      },
    ],
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
const rowName = /font-mono text-sm">([^<]+)</;

function markup(subject: Entity) {
  return renderToStaticMarkup(
    createElement(
      DisplayProvider,
      null,
      createElement(PodsTab, {
        view,
        entity: subject,
        summary: summarize(view, subject, now),
        coverage: { active: 5, finished: 1, measured: 0 },
        now,
        stale: false,
        onInspect: () => undefined,
      })
    )
  );
}

// Each pod's row, found by the pod's name, in display order.
function rows(subject: Entity = server) {
  const items = markup(subject).split("<li>").slice(1);
  const names = items.map((item) => rowName.exec(item)?.[1]);
  const row = (name: string) => {
    const found = items.find((item) => item.includes(`>${name}<`));
    if (!found) {
      throw new Error(`no row for ${name}`);
    }
    return found;
  };
  return { names, row };
}

describe("inspector Pods tab", () => {
  it("shows a finished failed pod as history, without a warning", () => {
    const { row } = rows();
    const finished = row("synthetic-report");
    expect(finished).toContain("Failed / OOM observed");
    expect(finished).toContain("Finished · not reporting");
    expect(finished).not.toContain(warning);
    // A live problem beside it keeps its warning.
    expect(row("synthetic-crash")).toContain(warning);
    expect(row("synthetic-web")).not.toContain(warning);
  });
  it("states the node's requested total as configured, not usage", () => {
    expect(markup(server)).toContain(
      "Requested / allocatable: CPU — (Request unknown for 1 of 5 pods) · Memory — (Request unknown for 1 of 5 pods) · configured requests, not usage"
    );
  });
  it("ranks live pods by memory request share, unknown last", () => {
    const { names, row } = rows();
    expect(names).toEqual([
      "synthetic-crash",
      "synthetic-api",
      "synthetic-cache",
      "synthetic-web",
      "synthetic-older",
      "synthetic-report",
    ]);
    expect(row("synthetic-web")).toContain("512 MiB req · 6.3% of allocatable");
    expect(row("synthetic-older")).toContain(
      "Memory request — · not reported by this observer"
    );
    // Finished pods reserve nothing.
    expect(row("synthetic-report")).not.toContain("req");
  });
  it("shows a workload's pods with absolute requests only", () => {
    const { row } = rows(workload);
    const web = row("synthetic-web");
    expect(web).toContain("Requests: CPU 500m, memory 512 MiB");
    expect(web).not.toContain("allocatable");
  });
});
