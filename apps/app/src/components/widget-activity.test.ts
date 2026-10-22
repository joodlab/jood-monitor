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
  data: Lifecycle[] | undefined
): UseQueryResult<Lifecycle[], Error> {
  return {
    data,
    isPending: false,
    isError: state === "error",
    isSuccess: state === "success",
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
  it("counts hidden rollout steps instead of saying nothing changed", () => {
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
    expect(html).toContain("besides 2 Deployment rollout steps");
    expect(html).not.toContain('role="alert"');
  });
  it("notes rollout steps left out of a non-empty list", () => {
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
    expect(html).toContain("1 Deployment rollout step not shown");
  });
  it("says the range was quiet only after a successful empty load", () => {
    expect(render(query("success", []))).toContain(quiet);
  });
});
