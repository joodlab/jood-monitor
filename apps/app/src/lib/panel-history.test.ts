import { describe, expect, it } from "vitest";
import { validateMonitorSearch } from "../schemas/monitor";
import {
  backStep,
  inspectFrom,
  inspectState,
  panelRest,
} from "./panel-history";

// Synthetic identifiers only: Deployment A opened, then its member pod B.

const a = validateMonitorSearch({
  view: "resources",
  tab: "workloads",
  workspace: "synthetic-demo",
  q: "checkout",
  range: "6",
  resource: "deploy-a",
  resourceCluster: "synthetic",
  panel: "pods",
});
const b = validateMonitorSearch({
  ...a,
  resource: "pod-b",
  panel: "metrics",
});

// The entry for B as the dashboard pushes it, read back from history.
function pushed() {
  const state = structuredClone(inspectState(a));
  return inspectFrom(state);
}

describe("history marker", () => {
  it("names the resource and page the entry was opened from", () => {
    expect(inspectState(a)).toEqual({
      inspectFrom: { key: "synthetic:deploy-a", rest: panelRest(a) },
    });
    const rest = panelRest(a);
    expect(rest).not.toHaveProperty("resource");
    expect(rest).not.toHaveProperty("panel");
    expect(rest).toMatchObject({ q: "checkout", range: "6" });
  });

  it("leaves no marker when no resource was open", () => {
    const closed = validateMonitorSearch({ view: "resources" });
    expect(inspectState(closed)).toBeUndefined();
  });

  it("reads only a well-formed marker back", () => {
    expect(pushed()?.key).toBe("synthetic:deploy-a");
    for (const state of [
      undefined,
      null,
      "inspectFrom",
      { inspectFrom: "synthetic:deploy-a" },
      { inspectFrom: { key: 7, rest: {} } },
      { inspectFrom: { key: "synthetic:deploy-a" } },
      { __TSR_index: 3, key: "abc" },
    ]) {
      expect(inspectFrom(state)).toBeUndefined();
    }
  });
});

describe("Back", () => {
  const crumbKey = "synthetic:deploy-a";

  it("follows browser history to the resource the entry came from", () => {
    expect(
      backStep({
        marker: pushed(),
        crumbKey,
        canGoBack: true,
        currentRest: panelRest(b),
      })
    ).toBe("history");
  });

  it("ignores the tab and link time, which stay with the resource", () => {
    const tabbed = validateMonitorSearch({ ...b, panel: "details" });
    expect(
      backStep({
        marker: pushed(),
        crumbKey,
        canGoBack: true,
        currentRest: panelRest(tabbed),
      })
    ).toBe("history");
  });

  it("opens the crumb in place for another resource", () => {
    expect(
      backStep({
        marker: pushed(),
        crumbKey: "synthetic:deploy-other",
        canGoBack: true,
        currentRest: panelRest(b),
      })
    ).toBe("replace");
    expect(
      backStep({
        marker: pushed(),
        crumbKey: "other-cluster:deploy-a",
        canGoBack: true,
        currentRest: panelRest(b),
      })
    ).toBe("replace");
  });

  it("opens the crumb in place once the page around the panel changed", () => {
    for (const change of [
      { range: "24" },
      { q: "payments" },
      { layout: "list" },
      { namespace: "shop" },
      { problems: true },
      { at: "2026-10-22T12:00:00Z" },
    ]) {
      const changed = validateMonitorSearch({ ...b, ...change });
      expect(
        backStep({
          marker: pushed(),
          crumbKey,
          canGoBack: true,
          currentRest: panelRest(changed),
        })
      ).toBe("replace");
    }
  });

  it("opens the crumb in place without a marker or a previous entry", () => {
    expect(
      backStep({
        marker: undefined,
        crumbKey,
        canGoBack: true,
        currentRest: panelRest(b),
      })
    ).toBe("replace");
    expect(
      backStep({
        marker: pushed(),
        crumbKey,
        canGoBack: false,
        currentRest: panelRest(b),
      })
    ).toBe("replace");
  });
});
