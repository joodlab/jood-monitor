// The service panel's Back. Opening another resource from an open one marks
// the new history entry with where it came from; Back then follows browser
// history only while that entry still shows the same page as when it was
// opened, so Back, the browser's Back and Forward all agree. Otherwise Back
// opens the previous resource in place.

import type { SearchState } from "../schemas/monitor";

type PanelRest = Omit<
  SearchState,
  "resource" | "resourceCluster" | "panel" | "linkedAt"
>;

export interface InspectMarker {
  // `<resourceCluster>:<resource>` of the resource the entry was opened from.
  key: string;
  // The rest of that page's search: scope, range, filters and layout.
  rest: Record<string, unknown>;
}

// The page around the panel: everything but the open resource.
export function panelRest(search: SearchState): PanelRest {
  const {
    resource: _resource,
    resourceCluster: _cluster,
    panel: _panel,
    linkedAt: _linkedAt,
    ...rest
  } = search;
  return rest;
}

// History state for an entry opened from the current search; none when no
// resource is open there.
export function inspectState(search: SearchState) {
  if (!search.resource) {
    return;
  }
  const inspectFrom: InspectMarker = {
    key: `${search.resourceCluster}:${search.resource}`,
    rest: panelRest(search),
  };
  return { inspectFrom };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The marker in an entry's history state, read defensively: the state may
// come from another version of the dashboard or another page.
export function inspectFrom(state: unknown): InspectMarker | undefined {
  const marker = isRecord(state) ? state.inspectFrom : undefined;
  if (
    !(
      isRecord(marker) &&
      typeof marker.key === "string" &&
      isRecord(marker.rest)
    )
  ) {
    return;
  }
  return { key: marker.key, rest: marker.rest };
}

// Search values are strings, numbers and booleans; a key set to undefined
// is the same as one left out.
function sameValues(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (isRecord(left) && isRecord(right)) {
      if (!sameValues(left, right)) {
        return false;
      }
    } else if (left !== right) {
      return false;
    }
  }
  return true;
}

// 'history' when the browser's previous entry is the crumb's resource on the
// same page: the entry was opened from that resource and nothing around the
// panel (range, search, layout, filters) has changed since.
export function backStep({
  marker,
  crumbKey,
  canGoBack,
  currentRest,
}: {
  marker?: InspectMarker;
  crumbKey: string;
  canGoBack: boolean;
  currentRest: Record<string, unknown>;
}): "history" | "replace" {
  return marker?.key === crumbKey &&
    canGoBack &&
    sameValues(marker.rest, currentRest)
    ? "history"
    : "replace";
}
