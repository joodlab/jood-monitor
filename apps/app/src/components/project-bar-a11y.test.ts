import type { ClusterView } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { clusterCrumb } from "../lib/collection-state";
import { ClusterCrumbRow } from "./project-bar";

// The project bar's words for keyboard, screen-reader and colour-blind
// users. Synthetic clusters and times only. The bar's staged-changes badge
// reaches the hub's server functions, which a unit test cannot load; these
// parts use none of them.
vi.mock("../functions/clusters", () => ({}));
vi.mock("../hooks/api/clusters", () => ({}));

const selected = Date.parse("2026-10-23T14:22:13Z");
const saved = {
  cluster: { environment: "synthetic fixture" },
  inventory: { sourceTime: "2026-10-23T14:14:19Z" },
} as unknown as ClusterView;

function row(now: number) {
  return renderToStaticMarkup(
    createElement(ClusterCrumbRow, {
      name: "Synthetic history (staged)",
      crumb: clusterCrumb(saved, now, true, "UTC"),
    })
  );
}

// The class list of the span whose text starts with `text`.
function classOf(markup: string, text: string) {
  return new RegExp(`<span class="([^"]*)">${text}`).exec(markup)?.[1];
}

describe("cluster crumb rows", () => {
  it("keeps a stale saved inventory's words in sight, never the dot alone", () => {
    const stale = row(selected);
    expect(stale).toContain("bg-warning");
    // The state leads the line, and the line wraps within the menu rather
    // than cutting the state or the saved time off with an ellipsis.
    const line = classOf(stale, "Stale at this time");
    expect(line).toContain("break-words");
    expect(line).not.toContain("truncate");
    const text = stale.replace(/<[^>]+>/g, "|");
    expect(text).toContain(
      "|Stale at this time · synthetic fixture · saved inventory Oct 23, 14:14:19 UTC|"
    );
    expect(text.indexOf("Stale")).toBeLessThan(text.indexOf("14:14:19"));
    // A long name still truncates on its own line.
    expect(classOf(stale, "Synthetic history")).toBe("block truncate");
  });

  it("wraps a fresh saved inventory's time too", () => {
    // Selected 41 s after the inventory was saved.
    const fresh = row(Date.parse("2026-10-23T14:15:00Z"));
    expect(fresh).toContain("bg-info");
    expect(fresh).not.toContain("Stale");
    expect(classOf(fresh, "synthetic fixture · saved inventory")).toContain(
      "break-words"
    );
  });
});
