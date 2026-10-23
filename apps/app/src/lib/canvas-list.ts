import type { Tone } from "./canvas-cards";
import type { GraphItem, TreeEntry } from "./service-graph";

// The canvas List reads problems first: critical, then warning, then stale,
// then everything else. Graph positions are untouched; only the rows move.

const toneRank: Record<Tone, number> = {
  critical: 0,
  warning: 1,
  stale: 2,
  healthy: 3,
  neutral: 3,
};

export function problemsFirstOrder(a: Tone, b: Tone) {
  return toneRank[a] - toneRank[b];
}

interface Ranked {
  entry: TreeEntry;
  tone: Tone;
}

// Sorts each level of the tree by the worst tone in a row's branch, so the
// path to a problem (an Ingress over a failing workload) rises with it.
// Rows that rank the same keep the graph's order.
export function problemsFirst(
  tree: TreeEntry[],
  toneOf: (item: GraphItem) => Tone
): TreeEntry[] {
  const rank = (entries: TreeEntry[]): Ranked[] =>
    entries
      .map((entry) => {
        const children = rank(entry.children);
        const tone = children.reduce<Tone>(
          (worst, child) =>
            problemsFirstOrder(child.tone, worst) < 0 ? child.tone : worst,
          toneOf(entry.item)
        );
        return {
          entry: { ...entry, children: children.map((child) => child.entry) },
          tone,
        };
      })
      .sort((a, b) => problemsFirstOrder(a.tone, b.tone));
  return rank(tree).map((ranked) => ranked.entry);
}
