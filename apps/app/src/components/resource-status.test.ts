import type { Entity } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { livePodProblem } from "../lib/attention";
import { StatusBadge, StatusLine } from "./resource-status";

// Synthetic pods and nodes only.
const now = Date.parse("2026-10-22T12:00:00Z");
function pod(status: string, ready = 0): Entity {
  return {
    uid: `synthetic-${status}`,
    kind: "Pod",
    name: "synthetic-job",
    namespace: "shop",
    status,
    ready,
    desired: 1,
  } as Entity;
}
const readyNode = {
  uid: "synthetic-node",
  kind: "Node",
  name: "synthetic-node",
  status: "True",
} as Entity;

const warning = "bg-warning/10";
function badge(entity: Entity, problem?: boolean) {
  return renderToStaticMarkup(createElement(StatusBadge, { entity, problem }));
}

describe("status badge", () => {
  it("shows a finished pod as history, failed or not", () => {
    // The inspector header passes no problem: a retained failure is history,
    // as on the canvas, never a warning.
    const failed = badge(pod("Failed / OOM observed"));
    expect(failed).not.toContain(warning);
    expect(failed).toContain("Failed / OOM observed");
    expect(badge(pod("Succeeded"))).not.toContain(warning);
    // Every table and list passes the live rule, which holds finished pods
    // as history too, so no surface warns about a retained failure.
    for (const status of ["Failed", "Failed / OOM observed", "Succeeded"]) {
      const finished = pod(status);
      expect(livePodProblem(finished, now)).toBe(false);
      expect(badge(finished, livePodProblem(finished, now))).not.toContain(
        warning
      );
    }
  });

  it("keeps a live problem a warning", () => {
    expect(badge(pod("CrashLoopBackOff"))).toContain(warning);
    expect(badge(pod("Running / OOM observed", 1))).toContain(warning);
    expect(badge(pod("Running", 1))).not.toContain(warning);
    const crashing = pod("CrashLoopBackOff");
    expect(badge(crashing, livePodProblem(crashing, now))).toContain(warning);
  });

  it("warns on a Ready node only as its caller's node rule says", () => {
    // Memory near full leaves the node Ready: the caller passes the
    // attention model's verdict rather than relying on the Ready condition.
    expect(badge(readyNode, true)).toContain(warning);
    expect(badge(readyNode, false)).not.toContain(warning);
    expect(
      renderToStaticMarkup(
        createElement(StatusLine, { entity: readyNode, problem: true })
      )
    ).toContain("text-warning-text");
  });
});
