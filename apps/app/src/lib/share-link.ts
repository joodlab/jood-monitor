// Links to the open service panel. A moment link opens the saved
// observation at a pinned instant; a live link opens whatever is current and
// remembers that instant (linkedAt) so a resource that is gone by then can
// still be offered as saved. Saved inventory is resolved by sourceTime ≤ at,
// so pinning the inventory's own source time opens exactly the observation
// on screen.

import type { PanelTab, SearchState } from "../schemas/monitor";
import {
  DAY_MS,
  INVENTORY_RETENTION_DAYS,
  RAW_RETENTION_DAYS,
} from "./retention";
import { type HubClock, hubNow, observationMs } from "./time";

export type ShareMode = "moment" | "live";

// The hub refuses an observation time this far past its own clock.
const AHEAD_MS = 60_000;

export const shareHints = {
  moment: `Opens frozen at this time. Inventory and events are kept ${INVENTORY_RETENTION_DAYS} days; raw CPU and memory samples up to ${RAW_RETENTION_DAYS} days.`,
  live: "Opens whatever is current when followed.",
  frozenLive: "Remembers this time in case the resource is gone.",
};

// The instant a moment link names, computed once when the link menu opens
// and used for its label and URL alike. Frozen, it is the saved observation.
// With a resource open it is the inspected cluster's inventory source time,
// exactly as the hub wrote it, unless that is ahead of the hub's clock; then
// the snapshot's hub time, then the estimated hub clock, then the browser's.
export function pinnedInstant({
  at,
  sourceTime,
  hubClock,
  now,
}: {
  at?: string;
  sourceTime?: string;
  hubClock?: HubClock;
  now: number;
}) {
  if (at) {
    return at;
  }
  const hub = hubNow(hubClock, now);
  const source = observationMs(sourceTime);
  if (
    sourceTime &&
    source != null &&
    (hub == null || source <= hub + AHEAD_MS)
  ) {
    return sourceTime;
  }
  if (hubClock && observationMs(hubClock.serverTime) != null) {
    return hubClock.serverTime;
  }
  return new Date(hub ?? now).toISOString();
}

interface MomentInputs {
  at?: string;
  hubClock?: HubClock;
  sourceTime?: string;
}

// The link menu's pinned moment as it opens or closes: computed afresh from
// what is on screen when it opens, and kept while it is open and closing.
export function pinOnOpen(
  pinned: string | undefined,
  open: boolean,
  inputs: MomentInputs & { now: number }
) {
  return open ? pinnedInstant(inputs) : pinned;
}

// The moment the menu labels and copies: the one pinned when it opened, so
// an inventory that arrives while it is open changes neither. Before the
// first open, the same rule without the browser clock, for a stable render.
export function menuMoment(pinned: string | undefined, inputs: MomentInputs) {
  return pinned ?? pinnedInstant({ ...inputs, now: 0 });
}

// The search a link carries: the whole current view, workspace, Settings
// section and diagnostic node included, with only the time keys changed.
export function shareSearch(
  search: SearchState,
  { mode, at, panel }: { mode: ShareMode; at: string; panel?: PanelTab }
): SearchState {
  const open = !!search.resource;
  if (mode === "moment") {
    return {
      ...search,
      at,
      panel: open ? panel : undefined,
      linkedAt: undefined,
    };
  }
  return {
    ...search,
    at: undefined,
    linkedAt: open ? (search.at ?? at) : undefined,
  };
}

// What a live link's copy time offers when its resource is absent: the saved
// observation while that time is within retention by the hub's clock.
export function linkedOffer(
  linkedAt: string | undefined,
  hubTime: number | undefined
): "none" | "retained" | "expired" {
  const time = observationMs(linkedAt);
  if (time == null) {
    return "none";
  }
  if (hubTime != null && time < hubTime - INVENTORY_RETENTION_DAYS * DAY_MS) {
    return "expired";
  }
  return "retained";
}
