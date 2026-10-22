import { describe, expect, it } from "vitest";
import type { Tone } from "./canvas-cards";
import { problemsFirst, problemsFirstOrder } from "./canvas-list";
import type { GraphItem, TreeEntry } from "./service-graph";

// Synthetic rows: each item's id doubles as its name, with a fixed tone.
function row(id: string, children: TreeEntry[] = []): TreeEntry {
  return { item: { id } as GraphItem, key: id, children };
}
const tones: Record<string, Tone> = {};
function toned(id: string, tone: Tone, children: TreeEntry[] = []) {
  tones[id] = tone;
  return row(id, children);
}
const toneOf = (item: GraphItem) => tones[item.id] ?? "neutral";
const ids = (entries: TreeEntry[]) => entries.map((entry) => entry.item.id);

describe("problems-first comparator", () => {
  it("orders critical, warning, stale, then the rest", () => {
    const order: Tone[] = [
      "healthy",
      "stale",
      "neutral",
      "warning",
      "critical",
    ];
    expect([...order].sort(problemsFirstOrder)).toEqual([
      "critical",
      "warning",
      "stale",
      "healthy",
      "neutral",
    ]);
  });
  it("ranks healthy and neutral rows together", () => {
    expect(problemsFirstOrder("healthy", "neutral")).toBe(0);
  });
});

describe("problems-first list", () => {
  it("moves problem rows up and keeps the graph order within a group", () => {
    const tree = [
      toned("ns-alpha", "healthy"),
      toned("ns-bravo", "stale"),
      toned("ns-charlie", "warning"),
      toned("ns-delta", "neutral"),
      toned("ns-echo", "critical"),
      toned("ns-foxtrot", "warning"),
    ];
    expect(ids(problemsFirst(tree, toneOf))).toEqual([
      "ns-echo",
      "ns-charlie",
      "ns-foxtrot",
      "ns-bravo",
      "ns-alpha",
      "ns-delta",
    ]);
  });

  it("raises the path to a nested problem with it", () => {
    const tree = [
      toned("ingress-quiet", "neutral", [toned("service-quiet", "healthy")]),
      toned("ingress-shop", "neutral", [
        toned("service-shop", "healthy", [
          toned("deployment-ok", "healthy"),
          toned("deployment-failing", "critical"),
        ]),
      ]),
    ];
    const sorted = problemsFirst(tree, toneOf);
    expect(ids(sorted)).toEqual(["ingress-shop", "ingress-quiet"]);
    const service = sorted[0]?.children[0];
    expect(ids(service?.children ?? [])).toEqual([
      "deployment-failing",
      "deployment-ok",
    ]);
  });

  it("leaves the input tree as it was", () => {
    const tree = [toned("ns-golf", "healthy"), toned("ns-hotel", "critical")];
    problemsFirst(tree, toneOf);
    expect(ids(tree)).toEqual(["ns-golf", "ns-hotel"]);
  });
});
