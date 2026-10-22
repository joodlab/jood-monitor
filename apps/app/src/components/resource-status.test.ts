import type { Entity } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./resource-status";

// Synthetic pods only.
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

const warning = "bg-warning/10";
function badge(entity: Entity, problem?: boolean) {
  return renderToStaticMarkup(createElement(StatusBadge, { entity, problem }));
}

describe("status badge", () => {
  it("shows a finished pod as history unless the caller marks a problem", () => {
    // The inspector header passes no problem: a retained failure is history,
    // as on the canvas, never a warning.
    const failed = badge(pod("Failed / OOM observed"));
    expect(failed).not.toContain(warning);
    expect(failed).toContain("Failed / OOM observed");
    expect(badge(pod("Succeeded"))).not.toContain(warning);
    // A table that counts the retained failure keeps its warning.
    expect(badge(pod("Failed"), true)).toContain(warning);
  });

  it("keeps a live problem a warning", () => {
    expect(badge(pod("CrashLoopBackOff"))).toContain(warning);
    expect(badge(pod("Running / OOM observed", 1))).toContain(warning);
    expect(badge(pod("Running", 1))).not.toContain(warning);
  });
});
