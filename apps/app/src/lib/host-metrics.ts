import type { ClusterView } from "@jood-monitor/api-client";
import type { SeriesHistorySeries } from "../contracts/types";
import type { ChartRow } from "./chart-scale";
import { collectionState } from "./collection-state";
import {
  counterPoints,
  counterRates,
  type DiagnosticSpan,
  gaugeRows,
  nanoMs,
  type RateRow,
} from "./history-series";
import { nodeProfileOutcome } from "./metrics";
import { DAY_MS, DIAGNOSTIC_RETENTION_DAYS } from "./retention";

// Host CPU and memory a node collector reads from /proc, as chart rows. The
// rules are the hub's: rates only between samples a counter can subtract,
// and a gap wherever any part of a value is missing.

export const hostNames = [
  "system.cpu.time",
  "system.memory.usage",
  "system.memory.limit",
] as const;

// /proc/stat states the collector reports; iowait is not collected.
export const cpuStates = [
  "user",
  "nice",
  "system",
  "idle",
  "interrupt",
  "softirq",
  "steal",
] as const;
export type CpuState = (typeof cpuStates)[number];
// Busy CPU is every reported state but idle.
const busyStates = cpuStates.filter((state) => state !== "idle");
// A period ending this close to the window's end may still be collecting:
// the slowest refresh plus one gap.
const ONGOING_MS = 210_000;

export interface BusyRow extends ChartRow {
  // Seconds the rates were taken over.
  interval?: number;
  profileChange?: boolean;
  // Each state's rate in CPU seconds per second (cores), null where the
  // state's pair was unusable, absent where the state has no sample.
  states: Partial<Record<CpuState, number | null>>;
}

// Each state's rates by exact source time. Only whole-host series count: one
// attribute, the state, so a per-CPU series is never added to the total.
function stateRates(series: readonly SeriesHistorySeries[]) {
  const states = new Map<CpuState, Map<string, RateRow>>();
  for (const state of cpuStates) {
    const own = series.filter(
      (item) =>
        item.name === "system.cpu.time" &&
        Object.keys(item.attributes).length === 1 &&
        item.attributes.state === state
    );
    const rows = new Map<string, RateRow>();
    for (const points of counterPoints(own).values()) {
      for (const row of counterRates(points).rows) {
        rows.set(row.nano, row);
      }
    }
    if (rows.size) {
      states.set(state, rows);
    }
  }
  return states;
}

function busyAt(
  nano: string,
  states: ReadonlyMap<CpuState, ReadonlyMap<string, RateRow>>
) {
  const rates: BusyRow["states"] = {};
  let interval: number | undefined;
  let profileChange = false;
  let reset = false;
  for (const state of cpuStates) {
    const row = states.get(state)?.get(nano);
    if (!row) {
      continue;
    }
    rates[state] = row.value;
    interval ??= row.interval;
    profileChange ||= !!row.profileChange;
    reset ||= !!row.reset && state !== "idle";
  }
  let value: number | null = 0;
  for (const state of busyStates) {
    const rate = rates[state];
    value = rate == null || value == null ? null : value + rate;
  }
  return {
    row: {
      time: nanoMs(nano),
      value,
      states: rates,
      ...(interval == null ? {} : { interval }),
      ...(profileChange ? { profileChange } : {}),
    } satisfies BusyRow,
    reset,
  };
}

// Busy cores at each source time: user + nice + system + interrupt + softirq
// + steal, only where all six have a rate. A partial sum is never drawn.
export function hostCpu(series: readonly SeriesHistorySeries[]) {
  const states = stateRates(series);
  const times = new Map<string, bigint>();
  for (const rows of states.values()) {
    for (const nano of rows.keys()) {
      times.set(nano, BigInt(nano));
    }
  }
  const ordered = [...times].sort(([, a], [, b]) => {
    if (a === b) {
      return 0;
    }
    return a > b ? 1 : -1;
  });
  const rows: BusyRow[] = [];
  let gaps = 0;
  let resets = 0;
  for (const [nano] of ordered) {
    const { row, reset } = busyAt(nano, states);
    if (row.value == null) {
      if (reset) {
        resets++;
      } else {
        gaps++;
      }
    }
    rows.push(row);
  }
  return { rows, gaps, resets };
}

export interface MemoryRow extends ChartRow {
  // MemAvailable at the same source time, when reported.
  available?: number;
}

function stateSeries(series: readonly SeriesHistorySeries[], state: string) {
  return series.filter(
    (item) =>
      item.name === "system.memory.usage" && item.attributes.state === state
  );
}

// The latest system.memory.limit (MemTotal) in the window.
function latestLimit(series: readonly SeriesHistorySeries[]) {
  let latest: { nano: bigint; value: number } | undefined;
  for (const item of series) {
    if (item.name !== "system.memory.limit") {
      continue;
    }
    for (const [nano, raw] of item.points) {
      const value = Number(raw);
      if (Number.isFinite(value) && (!latest || BigInt(nano) > latest.nano)) {
        latest = { nano: BigInt(nano), value };
      }
    }
  }
  return latest && { time: nanoMs(String(latest.nano)), value: latest.value };
}

// Memory in use (state=used: MemTotal − MemAvailable) with gaps over GAP_MS.
export function hostMemory(series: readonly SeriesHistorySeries[]) {
  const available = new Map<number, number>();
  for (const item of stateSeries(series, "available")) {
    for (const [nano, raw] of item.points) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        available.set(nanoMs(nano), value);
      }
    }
  }
  const rows: MemoryRow[] = gaugeRows(stateSeries(series, "used")).map(
    (row) => {
      const free = row.value == null ? undefined : available.get(row.time);
      return free == null ? row : { ...row, available: free };
    }
  );
  return { rows, memTotal: latestLimit(series) };
}

// The collection profile of the newest host sample, as its source stamped it.
export function latestHostProfile(series: readonly SeriesHistorySeries[]) {
  let latest: { nano: bigint; profile?: string } | undefined;
  for (const item of series) {
    const last = item.points.at(-1);
    if (
      last &&
      (hostNames as readonly string[]).includes(item.name) &&
      (!latest || BigInt(last[0]) > latest.nano)
    ) {
      latest = { nano: BigInt(last[0]), profile: item.profile };
    }
  }
  return latest?.profile;
}

// Rates need two samples; a single sample still counts as host data.
export function hasHostSamples(series: readonly SeriesHistorySeries[]) {
  return series.some((item) => item.points.length > 0);
}

// Why a live node has no host samples, as far as the hub knows. A saved
// observation's settings say nothing about the collector now, so it gets
// the general reason.
export function hostEmptyReason(
  view: ClusterView,
  uid: string,
  now: number,
  live: boolean
) {
  if (live && view.profile.paused) {
    return "Collection is paused, so the node collector takes no host samples.";
  }
  if (live && nodeProfileOutcome(view, uid, now).startsWith("Unavailable")) {
    return "No node collector acknowledgment from this node. The node collector DaemonSet runs on linux/amd64 nodes without taints by default.";
  }
  return "No host samples in this interval. The node collector reports every 60 s; check this node's collection acknowledgment in Details.";
}

export interface DiagnosticState {
  expiresAt: number;
  returnTo: string;
  status: "paused" | "running" | "waiting";
}

// The Diagnostic this node is in at `now` (live only): running once the
// node collector acknowledged it, otherwise waiting, or paused.
export function nodeDiagnostic(
  view: ClusterView,
  uid: string,
  now: number
): DiagnosticState | undefined {
  const state = collectionState(view, now);
  if (!state.diagnostic?.nodeUids.includes(uid)) {
    return;
  }
  const { expiresAt, returnTo } = state.diagnostic;
  if (state.paused) {
    return { status: "paused", expiresAt, returnTo };
  }
  return {
    status:
      nodeProfileOutcome(view, uid, now) === "Acknowledged"
        ? "running"
        : "waiting",
    expiresAt,
    returnTo,
  };
}

// Periods whose samples stopped. While a Diagnostic runs, the period still
// reaching the window's end is the running one.
export function endedSpans(
  spans: readonly DiagnosticSpan[],
  running: boolean,
  windowTo: number
) {
  return spans.filter(
    (item) => !(running && item.end >= windowTo - ONGOING_MS)
  );
}

// Diagnostic samples older than this, at `now`, are gone; a window reaching
// further back may show those periods as gaps.
export function diagnosticCutoff(windowFrom: number, now: number) {
  const cutoff = now - DIAGNOSTIC_RETENTION_DAYS * DAY_MS;
  return windowFrom < cutoff ? cutoff : undefined;
}
