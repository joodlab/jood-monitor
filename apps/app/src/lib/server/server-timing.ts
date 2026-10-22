type TimingStage = "archive" | "d1" | "do";

const descriptions: Record<TimingStage | "total", string> = {
  d1: "D1 cluster registry",
  do: "Durable Object state",
  archive: "Saved history (D1 index and R2)",
  total: "Server function",
};

export interface Timing {
  header(): string;
  measure<T>(stage: TimingStage, work: () => PromiseLike<T>): Promise<T>;
}

interface Stage {
  active: number;
  busy: number;
  since: number;
}

function metric(name: TimingStage | "total", duration: number) {
  return `${name};dur=${duration.toFixed(1)};desc="${descriptions[name]}"`;
}

// Time spent waiting on each store, for a Server-Timing header. Overlapping
// waits on one stage count once, so no stage can exceed the total. Stages a
// request never waited on are omitted rather than reported as zero.
export function createTiming(clock: () => number = () => performance.now()) {
  const started = clock();
  const stages = new Map<TimingStage, Stage>();
  const timing: Timing = {
    async measure(stage, work) {
      const entry = stages.get(stage) ?? { active: 0, busy: 0, since: 0 };
      stages.set(stage, entry);
      if (entry.active === 0) {
        entry.since = clock();
      }
      entry.active++;
      try {
        return await work();
      } finally {
        entry.active--;
        if (entry.active === 0) {
          entry.busy += clock() - entry.since;
        }
      }
    },
    header() {
      const now = clock();
      return [
        ...[...stages].map(([stage, entry]) =>
          metric(stage, entry.busy + (entry.active ? now - entry.since : 0))
        ),
        metric("total", now - started),
      ].join(", ");
    },
  };
  return timing;
}
