import type { ClusterView } from "@jood-monitor/api-client";
import { useEffect, useSyncExternalStore } from "react";
import { type DeliveryWatch, nextWatch } from "../lib/delivery-watch";
import { freshness } from "../lib/metrics";
import { useDisplay } from "./display";

// The delivery totals this page has seen, per cluster, for as long as the
// page stays open. One map serves every surface (the project bar keeps it
// current from any tab; Settings and Observability read it), and only fresh
// live heartbeats move it: a saved observation is never watched.

const watches = new Map<string, DeliveryWatch>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const currentVersion = () => version;
const serverVersion = () => 0;

// Records each live view's latest heartbeat, judged fresh at `now`.
export function recordDeliveryWatch(
  views: readonly ClusterView[],
  now: number
) {
  let changed = false;
  for (const view of views) {
    const previous = watches.get(view.cluster.id);
    const next = nextWatch(
      previous,
      {
        dropped: view.heartbeat.dropped,
        rejectedPoints: view.heartbeat.rejectedPoints,
        queueBytes: view.heartbeat.queueBytes,
        heartbeatAt: view.cluster.heartbeatAt,
        fresh: freshness(view.cluster.heartbeatAt, now) === "fresh",
      },
      now
    );
    if (next && next !== previous) {
      watches.set(view.cluster.id, next);
      changed = true;
    }
  }
  if (changed) {
    version++;
    for (const listener of listeners) {
      listener();
    }
  }
}

// Watches `views` while the dashboard is live and returns every cluster's
// watch. Pass a stable array: the views are recorded whenever it changes.
export function useDeliveryWatch(
  views: readonly ClusterView[]
): ReadonlyMap<string, DeliveryWatch> {
  const { frozen, now } = useDisplay();
  useSyncExternalStore(subscribe, currentVersion, serverVersion);
  useEffect(() => {
    if (!frozen && now) {
      recordDeliveryWatch(views, now);
    }
  }, [views, frozen, now]);
  return watches;
}
