import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { type ChangesQuery, ChangesTab, useChangeRows } from "./panel-changes";

// The rows render from the given query; nothing is fetched.
vi.mock("../hooks/api/clusters", () => ({ fetchClusterChanges: vi.fn() }));

// A synthetic checkout Deployment with one ReplicaSet, and a node the hub
// first observed long after it was created. Identifiers are invented.
const T = Date.parse("2026-10-22T12:00:00Z");
const ago = (minutes: number) => new Date(T - minutes * 60_000).toISOString();
const MiB = 1024 ** 2;
const DAY_MINUTES = 24 * 60;

function entity(fields: Partial<Entity> & { uid: string; kind: string }) {
  return { name: fields.uid, status: "Observed", ...fields } as Entity;
}

const deployment = entity({
  uid: "deploy-checkout",
  kind: "Deployment",
  name: "checkout",
  namespace: "shop",
  desired: 4,
});
const replicaSet = entity({
  uid: "rs-new",
  kind: "ReplicaSet",
  name: "checkout-5b8d4",
  namespace: "shop",
  createdAt: ago(40),
});
const node = entity({
  uid: "node-c",
  kind: "Node",
  name: "synthetic-node-c",
  createdAt: ago(40 * DAY_MINUTES),
});

const view = {
  cluster: {
    id: "synthetic-history",
    name: "Synthetic history",
    workspaceId: "synthetic-workspace",
  },
  inventory: {
    entities: [deployment, replicaSet, node],
    edges: [
      {
        source: "rs-new",
        target: "deploy-checkout",
        relation: "owned_by",
        evidence: "Synthetic fixture",
      },
    ],
    capabilities: [],
    sourceTime: ago(1),
  },
  metrics: [],
} as unknown as ClusterView;

let serial = 0;
function inventoryEvent(
  kind: string,
  subject: Entity,
  before: Partial<Entity>,
  after: Partial<Entity>,
  observedAt: string
): Lifecycle {
  serial++;
  return {
    id: `event-${serial}`,
    clusterId: "synthetic-history",
    kind,
    before: JSON.stringify({ ...subject, ...before }),
    after: JSON.stringify({ ...subject, ...after }),
    evidence: "Kubernetes inventory reconciliation",
    attribution: "unknown",
    observedAt,
    receivedAt: observedAt,
  };
}

// Newest first, as the hub returns them.
const events = [
  inventoryEvent(
    "workload_horizontal",
    replicaSet,
    { desired: 1 },
    { desired: 4 },
    ago(30)
  ),
  inventoryEvent(
    "workload_horizontal",
    deployment,
    { desired: 3, requestedMemory: 512 * MiB },
    { desired: 4, requestedMemory: 768 * MiB },
    ago(35)
  ),
  inventoryEvent("node_join", node, {}, {}, ago(10 * DAY_MINUTES)),
];

const query = {
  data: events,
  dataUpdatedAt: T,
  isError: false,
  isPending: false,
  refetch: () => undefined,
} as unknown as ChangesQuery;

function Tab({ subject }: { subject: Entity }) {
  const changes = useChangeRows(events, view, subject);
  return createElement(ChangesTab, {
    view,
    entity: subject,
    query,
    changes,
    stale: false,
    onInspect: () => undefined,
  });
}

function markup(subject: Entity) {
  return renderToStaticMarkup(
    createElement(DisplayProvider, null, createElement(Tab, { subject }))
  );
}

// Each field chip's label, in display order.
function chipLabels(html: string) {
  return [
    ...html.matchAll(/<span class="text-muted-foreground">([^<]+)<\/span>/g),
  ].map((match) => match[1]);
}

describe("Changes tab rows", () => {
  it("lists only the changes the headline does not already state", () => {
    const html = markup(deployment);
    expect(html).toContain("Replicas 3 → 4");
    expect(html).toContain("Replicas 1 → 4");
    // Neither replica step repeats as a chip; the memory request is listed.
    expect(chipLabels(html)).toEqual(["Memory request"]);
  });

  it("labels each time by what it measures", () => {
    const html = markup(deployment);
    expect(html.match(/First observed in inventory/g)).toHaveLength(2);
  });

  it("says when a node first observed long after creation was created", () => {
    const html = markup(node);
    expect(html).toContain(" · created ");
    // A plain time element, not a tab stop, so the row's only tab stops
    // stay its actions.
    expect(html).toContain(
      `<time class="tabular-nums" dateTime="${node.createdAt}">`
    );
  });

  it("names no creation time for workload changes", () => {
    expect(markup(deployment)).not.toContain(" · created ");
  });
});
