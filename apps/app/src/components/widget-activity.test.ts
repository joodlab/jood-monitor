import type { Lifecycle } from "@jood-monitor/api-client";
import type { UseQueryResult } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { ActivityWidget } from "./widget-activity";

// Server-rendered markup of the Recent activity widget for query states the
// dashboard can hand it. Synthetic events only.

let sequence = 0;
function event(kind: string, before: unknown, after: unknown): Lifecycle {
  sequence++;
  return {
    id: `${kind}-${sequence}`,
    clusterId: "c1",
    kind,
    before: JSON.stringify(before),
    after: JSON.stringify(after),
    evidence: "Kubernetes inventory reconciliation",
    attribution: "unknown",
    observedAt: "2026-10-22T12:00:00Z",
    receivedAt: "2026-10-22T12:00:01Z",
  } as Lifecycle;
}

const rs = { uid: "r", kind: "ReplicaSet", name: "web-7c9", namespace: "shop" };
const node = { uid: "n", kind: "Node", name: "node-a" };

function query(
  state: "success" | "error",
  data: Lifecycle[] | undefined,
  placeholder = false
): UseQueryResult<Lifecycle[], Error> {
  return {
    data,
    isPending: false,
    isError: state === "error",
    isSuccess: state === "success",
    isPlaceholderData: placeholder,
    refetch: () => Promise.resolve(),
  } as unknown as UseQueryResult<Lifecycle[], Error>;
}

function render(events: UseQueryResult<Lifecycle[], Error>) {
  return renderToStaticMarkup(
    createElement(
      DisplayProvider,
      null,
      createElement(ActivityWidget, {
        events,
        views: [],
        onAll: () => undefined,
      })
    )
  );
}

const quiet = "No node, scaling or resource changes were observed";

describe("Recent activity widget", () => {
  it("does not claim a quiet range when a refresh of an empty list failed", () => {
    const html = render(query("error", []));
    expect(html).toContain('role="alert"');
    expect(html).toContain("could not be refreshed");
    expect(html).toContain("Retry");
    expect(html).not.toContain(quiet);
  });
  it("reports history as unavailable when nothing was ever loaded", () => {
    const html = render(query("error", undefined));
    expect(html).toContain("Change history is unavailable.");
    expect(html).not.toContain(quiet);
  });
  it("labels cached rows as the last loaded changes after a failure", () => {
    const html = render(query("error", [event("node_join", {}, node)]));
    expect(html).toContain("Showing the last loaded changes.");
    expect(html).toContain("node-a");
  });
  it("counts hidden ReplicaSet changes instead of saying nothing changed", () => {
    const html = render(
      query("success", [
        event(
          "workload_horizontal",
          { ...rs, desired: 0 },
          { ...rs, desired: 1 }
        ),
        event(
          "workload_horizontal",
          { ...rs, desired: 1 },
          { ...rs, desired: 2 }
        ),
      ])
    );
    expect(html).not.toContain(quiet);
    expect(html).toContain("besides 2 ReplicaSet changes");
    expect(html.toLowerCase()).not.toContain("rollout");
    expect(html).not.toContain('role="alert"');
  });
  it("notes ReplicaSet changes left out of a non-empty list", () => {
    const html = render(
      query("success", [
        event("node_join", {}, node),
        event(
          "workload_horizontal",
          { ...rs, desired: 0 },
          { ...rs, desired: 1 }
        ),
      ])
    );
    expect(html).toContain("node-a");
    expect(html).toContain("1 ReplicaSet change not shown");
  });
  it("labels each time by what it measures", () => {
    const resize = {
      ...event("receipt_resize", null, null),
      before: "4 vCPU",
      after: "8 vCPU",
      attribution: "reported",
      evidence: JSON.stringify({ serverId: "srv-1", nodeUid: "n" }),
    };
    const html = render(
      query("success", [
        resize,
        event("node_join", {}, { ...node, createdAt: "2026-09-12T12:00:00Z" }),
      ])
    );
    expect(html).toContain("Reported time: ");
    expect(html).toContain(
      "Reported by automation · not independently verified"
    );
    expect(html).not.toContain("· reported by automation");
    expect(html).toContain("First observed in inventory: ");
    expect(html).toContain("First observed in inventory</p>");
    expect(html).toContain(" · created ");
    expect(html).not.toContain("(Observed: ");
  });
  it("says the range was quiet only after a successful empty load", () => {
    expect(render(query("success", []))).toContain(quiet);
  });
  it("reads an empty previous range as loading while a new range loads", () => {
    const html = render(query("success", [], true));
    expect(html).not.toContain(quiet);
    expect(html).toContain("Loading activity…");
  });
});
