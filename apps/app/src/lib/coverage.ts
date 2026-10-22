import type { ClusterView } from "@jood-monitor/api-client";
import { observationCoverage } from "./attention";
import { freshness, inventoryFreshness } from "./metrics";
import type { InventoryCoverage } from "./service-graph";

// When an empty view may say "no problems". The canvas and the Servers view
// share this rule, so neither turns missing inventory, stale inventory or a
// silent observer into an all clear that the attention badge contradicts.

export interface ClusterCoverage extends InventoryCoverage {
  // Of the aged clusters, those whose inventory is fresh but whose live
  // observer heartbeat is not (stale, ahead of the hub clock or missing).
  observerAged: number;
}

// What the inventory in scope can vouch for: clusters with none at all, and
// clusters whose last inventory is no longer fresh. Live, a heartbeat that
// is not fresh ages the inventory too: the observer may have stopped before
// its last inventory went stale, so it cannot vouch for an all clear beside
// the stale-observer problem. Those are counted apart so the copy names the
// heartbeat, not the inventory, as the reason.
export function inventoryCoverage(
  views: ClusterView[],
  now: number,
  frozen = false
): ClusterCoverage {
  const coverage = observationCoverage(views, now);
  let aged = 0;
  let observerAged = 0;
  for (const view of views) {
    const inventory = inventoryFreshness(view.inventory.sourceTime, now);
    if (inventory === "unknown") {
      continue;
    }
    if (inventory !== "fresh") {
      aged++;
    } else if (
      !frozen &&
      freshness(view.cluster.heartbeatAt, now) !== "fresh"
    ) {
      aged++;
      observerAged++;
    }
  }
  return { ...coverage, aged, observerAged };
}

// Every cluster in scope has current inventory (and, live, a current
// observer heartbeat), so an empty problem list is an all clear.
export function fullyCovered(coverage: ClusterCoverage) {
  return !(coverage.missing || coverage.aged);
}

// Registered clusters that have sent nothing: no observer heartbeat and no
// inventory. Saved observations keep no heartbeats, so only the live view
// can name them. Neither check depends on the clock.
export function silentClusters(views: ClusterView[], frozen: boolean) {
  return frozen
    ? []
    : views.filter(
        (view) =>
          freshness(view.cluster.heartbeatAt) === "unknown" &&
          inventoryFreshness(view.inventory.sourceTime) === "unknown"
      );
}

function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Why the coverage cannot vouch for an all clear, one sentence per reason;
// empty when it can.
export function coverageNotes(coverage: ClusterCoverage, frozen: boolean) {
  const notes: string[] = [];
  if (coverage.missing) {
    notes.push(
      `${coverage.missing} of ${counted(coverage.total, "cluster")} ${frozen ? "have no saved observation at this time" : "have not reported inventory"}, so their problems cannot be evaluated.`
    );
  }
  const staleInventory = coverage.aged - coverage.observerAged;
  if (staleInventory) {
    notes.push(
      coverage.total === 1
        ? "The inventory is stale, so the current state is unknown."
        : `${staleInventory} of ${counted(coverage.total, "cluster")} have stale inventory, so their current state is unknown.`
    );
  }
  if (coverage.observerAged) {
    notes.push(
      coverage.total === 1
        ? "The observer heartbeat is not current, so the current state is unknown."
        : `${coverage.observerAged} of ${counted(coverage.total, "cluster")} have no current observer heartbeat, so their current state is unknown.`
    );
  }
  return notes.join(" ");
}

const NAMED_CLUSTERS = 3;

function nameList(names: string[]) {
  const shown = names.slice(0, NAMED_CLUSTERS);
  const more = names.length - shown.length;
  if (more > 0) {
    return `${shown.join(", ")} and ${more} more`;
  }
  const last = shown.pop();
  return shown.length ? `${shown.join(", ")} and ${last}` : (last ?? "");
}

// "synthetic-a has not reported since registration.", naming up to three
// clusters; empty without any.
export function silentText(names: string[]) {
  if (!names.length) {
    return "";
  }
  const verb = names.length === 1 ? "has" : "have";
  return `${nameList(names)} ${verb} not reported since registration.`;
}
