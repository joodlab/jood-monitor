import { describe, expect, it } from "vitest";
import { drawsResource, selectInspected } from "./canvas-selection";

// Synthetic clusters and uids only.
function card(cluster: string, uid: string, selected?: boolean) {
  return {
    id: `${cluster}:${uid}`,
    selected,
    data: { item: { entity: { uid }, view: { cluster: { id: cluster } } } },
  };
}

describe("canvas selection that follows the service panel", () => {
  const a = card("cluster-a", "uid-1", true);
  const b = card("cluster-a", "uid-2");
  // The same uid in another cluster, as a restored cluster would have.
  const twin = card("cluster-b", "uid-2");
  const cards = [a, b, twin];

  it("selects the card the panel switched to from outside the canvas", () => {
    const next = selectInspected(cards, { cluster: "cluster-a", uid: "uid-2" });
    expect(next.map((item) => item.selected ?? false)).toEqual([
      false,
      true,
      false,
    ]);
    // Only the cards whose selection changed are new objects.
    expect(next[2]).toBe(twin);
  });

  it("matches the cluster as well as the uid", () => {
    const next = selectInspected(cards, { cluster: "cluster-b", uid: "uid-2" });
    expect(next.find((item) => item.selected)?.id).toBe("cluster-b:uid-2");
    expect(
      drawsResource(b.data.item, { cluster: "cluster-b", uid: "uid-2" })
    ).toBe(false);
  });

  it("clears the selection when the panel closes", () => {
    const next = selectInspected(cards, {});
    expect(next.some((item) => item.selected)).toBe(false);
  });

  it("clears the selection when the inspected resource has no card", () => {
    // A pod inside a collapsed group, or a resource the filters hide.
    const next = selectInspected(cards, {
      cluster: "cluster-a",
      uid: "uid-hidden",
    });
    expect(next.some((item) => item.selected)).toBe(false);
  });

  it("keeps the array when the inspected card is already the selection", () => {
    // A click selects the card before the panel opens on it.
    expect(selectInspected(cards, { cluster: "cluster-a", uid: "uid-1" })).toBe(
      cards
    );
    const none = [b, twin];
    expect(selectInspected(none, {})).toBe(none);
  });
});
