import { describe, expect, it } from "vitest";
import { measuredChanges } from "./canvas-node-changes";

// Shapes of React Flow node changes, with synthetic card ids.
const measured = {
  type: "dimensions",
  id: "card-a",
  dimensions: { width: 240, height: 96 },
};

describe("node changes the canvas takes from React Flow", () => {
  it("keeps card measurements", () => {
    expect(measuredChanges([measured])).toEqual([measured]);
  });

  it("drops selection so only the service panel selects a card", () => {
    // A click on a namespace card, a pane click or Escape would otherwise
    // select or clear a card the panel does not show.
    const changes = [
      { type: "select", id: "card-a", selected: true },
      measured,
      { type: "select", id: "card-b", selected: false },
    ];
    expect(measuredChanges(changes)).toEqual([measured]);
  });

  it("drops moves, removals and additions of read-only cards", () => {
    const changes = [
      { type: "position", id: "card-a", position: { x: 1, y: 2 } },
      { type: "remove", id: "card-a" },
      { type: "add", item: { id: "card-c" } },
      { type: "replace", id: "card-b", item: { id: "card-b" } },
    ];
    expect(measuredChanges(changes)).toEqual([]);
  });
});
