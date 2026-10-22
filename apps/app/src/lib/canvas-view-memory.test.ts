import { describe, expect, it } from "vitest";
import {
  canvasViewKey,
  centredViewport,
  createCanvasViewMemory,
  nextCanvasView,
  openingViewport,
  restoredCanvasView,
} from "./canvas-view-memory";

// Synthetic workspace, cluster and card ids only.
const key = canvasViewKey("synthetic-workspace", undefined, "all");
const filter = "all::false:false";
const viewport = { x: -120, y: 40, zoom: 0.8 };
const positions = { "card-a": { x: 0, y: 0 }, "card-b": { x: 400, y: 0 } };

describe("canvas view memory", () => {
  it("keys views by workspace, cluster and namespace only", () => {
    expect(canvasViewKey("synthetic-workspace", undefined, "all")).toBe(
      "synthetic-workspace:all:all"
    );
    expect(canvasViewKey("synthetic-workspace", "cluster-a", "shop")).toBe(
      "synthetic-workspace:cluster-a:shop"
    );
  });

  it("restores expanded cards, positions and the viewport after a remount", () => {
    const memory = createCanvasViewMemory();
    memory.remember(key, { expanded: ["card-a"] });
    memory.remember(key, { filter, positions });
    memory.remember(key, { filter, viewport });
    expect(restoredCanvasView(memory.recall(key), filter)).toEqual({
      expanded: ["card-a"],
      positions,
      viewport,
    });
  });

  it("fits on a first visit, when nothing was saved", () => {
    const memory = createCanvasViewMemory();
    expect(restoredCanvasView(memory.recall(key), filter)).toEqual({
      expanded: [],
      positions: {},
      viewport: undefined,
    });
  });

  it("skips the fit only when a viewport was saved under the same filter", () => {
    const memory = createCanvasViewMemory();
    memory.remember(key, { filter, positions });
    // Laid out but never fitted or moved: still fit.
    expect(restoredCanvasView(memory.recall(key), filter).viewport).toBe(
      undefined
    );
    memory.remember(key, { filter, viewport });
    expect(restoredCanvasView(memory.recall(key), filter).viewport).toEqual(
      viewport
    );
    // Another filter draws another graph: fresh layout and fit.
    const other = restoredCanvasView(memory.recall(key), "all:web:false:false");
    expect(other.viewport).toBe(undefined);
    expect(other.positions).toEqual({});
  });

  it("opens a new mount on the saved viewport instead of fitting", () => {
    // A loading remount, Back to the namespace or a List to Graph switch.
    const memory = createCanvasViewMemory();
    memory.remember(key, { filter, positions });
    memory.remember(key, { filter, viewport });
    expect(openingViewport(true, memory.recall(key), filter)).toEqual(viewport);
  });

  it("fits a first visit, a changed filter and a refit after the opening", () => {
    const memory = createCanvasViewMemory();
    expect(openingViewport(true, memory.recall(key), filter)).toBe(undefined);
    memory.remember(key, { filter, viewport });
    // Saved under another filter: that drawing is gone.
    expect(
      openingViewport(true, memory.recall(key), "all:web:false:false")
    ).toBe(undefined);
    // The filter changed under the mount: the new graph fits even if a
    // viewport for it was saved meanwhile.
    expect(openingViewport(false, memory.recall(key), filter)).toBe(undefined);
  });

  it("drops the drawing, not the expanded cards, when the filter changes", () => {
    const saved = nextCanvasView(
      { expanded: ["card-a"], filter, positions, viewport },
      { filter: "all::false:true", positions: { "card-c": { x: 0, y: 0 } } }
    );
    expect(saved).toEqual({
      expanded: ["card-a"],
      filter: "all::false:true",
      positions: { "card-c": { x: 0, y: 0 } },
    });
  });

  it("keeps the drawing when only the expanded cards change", () => {
    const saved = nextCanvasView(
      { expanded: [], filter, positions, viewport },
      { expanded: ["card-b"] }
    );
    expect(saved).toEqual({
      expanded: ["card-b"],
      filter,
      positions,
      viewport,
    });
  });

  it("forgets the least recently used view beyond its limit", () => {
    const memory = createCanvasViewMemory(2);
    memory.remember("first", { expanded: ["card-a"] });
    memory.remember("second", { expanded: ["card-b"] });
    // Using the first view again makes the second the oldest.
    memory.remember("first", { filter });
    memory.remember("third", { expanded: [] });
    expect(memory.recall("first")?.expanded).toEqual(["card-a"]);
    expect(memory.recall("second")).toBe(undefined);
    expect(memory.recall("third")).toBeDefined();
  });
});

describe("centring a card in the clear canvas area", () => {
  const canvas = { width: 1600, height: 900 };
  const card = { x: 1000, y: 200, width: 288, height: 168 };

  it("centres the card between the overlays at the current zoom", () => {
    const clear = { top: 72, left: 72, bottom: 64, right: 40 };
    const next = centredViewport(card, 1, canvas, clear);
    expect(next.zoom).toBe(1);
    const left = card.x * next.zoom + next.x;
    const right = left + card.width * next.zoom;
    // Equal space either side inside the clear area.
    expect(left - clear.left).toBeCloseTo(canvas.width - clear.right - right);
    const top = card.y * next.zoom + next.y;
    const bottom = top + card.height * next.zoom;
    expect(top - clear.top).toBeCloseTo(canvas.height - clear.bottom - bottom);
  });

  it("keeps the card left of a docked service panel", () => {
    // A 960 px panel docked over the right of a 1600 px canvas.
    const clear = { top: 72, left: 72, bottom: 64, right: 976 + 24 };
    const next = centredViewport(card, 1, canvas, clear);
    const right = (card.x + card.width) * next.zoom + next.x;
    expect(right).toBeLessThanOrEqual(canvas.width - clear.right);
    expect(card.x * next.zoom + next.x).toBeGreaterThanOrEqual(clear.left);
  });

  it("zooms out when the card is wider than the room beside the panel", () => {
    // A 768 px screen: the 560 px panel leaves 96 px of clear canvas.
    const small = { width: 768, height: 900 };
    const clear = { top: 72, left: 72, bottom: 64, right: 576 + 24 };
    const next = centredViewport(card, 1, small, clear);
    expect(next.zoom).toBeCloseTo(96 / 288);
    const left = card.x * next.zoom + next.x;
    expect(left).toBeCloseTo(clear.left);
    expect(left + card.width * next.zoom).toBeCloseTo(
      small.width - clear.right
    );
  });

  it("never zooms in to centre a card", () => {
    const clear = { top: 72, left: 72, bottom: 64, right: 40 };
    expect(centredViewport(card, 0.5, canvas, clear).zoom).toBe(0.5);
  });

  it("keeps the zoom when the overlays leave no clear area", () => {
    const clear = { top: 72, left: 72, bottom: 64, right: 2000 };
    expect(centredViewport(card, 0.8, canvas, clear).zoom).toBe(0.8);
  });
});
