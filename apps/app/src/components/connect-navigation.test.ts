import { describe, expect, it } from "vitest";
import { validateMonitorSearch } from "../schemas/monitor";
import { connectedSearch } from "./connect-navigation";

// The buttons shown after the first delivery, applied to the search the
// operator connected from. Synthetic identifiers only.

const cluster = { id: "cl-new", workspaceId: "ws-a" };

function from(raw: object) {
  return validateMonitorSearch(raw as Record<string, unknown>);
}

describe("connected cluster navigation", () => {
  it("opens the new cluster's servers from the Architecture canvas", () => {
    const old = from({ view: "architecture", q: "checkout", problems: true });
    expect(old.tab).toBe("workloads");
    const next = from(
      connectedSearch(old, cluster, {
        view: "resources",
        tab: "servers",
        q: "",
        problems: false,
      })
    );
    expect(next).toMatchObject({
      view: "resources",
      tab: "servers",
      mode: "servers",
      q: "",
      problems: false,
      workspace: "ws-a",
      cluster: "cl-new",
    });
  });
  it("keeps the servers tab when connecting from another resource tab", () => {
    const old = from({
      view: "resources",
      tab: "pods",
      at: "2026-10-22T12:00:00Z",
    });
    const next = from(
      connectedSearch(old, cluster, { view: "resources", tab: "servers" })
    );
    expect(next.tab).toBe("servers");
    expect(next.at).toBeUndefined();
  });
  it("opens collection settings for the new cluster", () => {
    const old = from({
      view: "observability",
      cluster: "cl-old",
      resource: "r1",
    });
    const next = from(connectedSearch(old, cluster, { view: "settings" }));
    expect(next).toMatchObject({ view: "settings", cluster: "cl-new" });
    expect(next.resource).toBeUndefined();
  });
});
