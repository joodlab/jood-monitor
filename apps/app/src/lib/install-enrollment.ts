import type { ClusterView } from "@jood-monitor/api-client";

// Client-side rules and outcomes for connecting a cluster. The hub stays the
// authority: these only explain its rules before submit and read its answers.

// registerCluster and recoverEnrollment issue tokens for 30 minutes.
export const enrollmentLifetimeMs = 30 * 60_000;
// After this long without a first heartbeat, show troubleshooting help.
export const firstHeartbeatPatienceMs = 2 * 60_000;

// The First heartbeat step checks the hub every 10 seconds for ten minutes,
// then every 30 seconds, measured from when the step started.
export const fastCheckMs = 10_000;
export const slowCheckMs = 30_000;
export const slowCheckAfterMs = 10 * 60_000;
// Automatic checks stop this long after the token expired with no heartbeat.
export const expiryGraceMs = 2 * 60_000;
// After a heartbeat, inventory checks stay slow and stop after this long.
export const inventoryPatienceMs = 10 * 60_000;

export const idRule = "Lowercase letters, digits and hyphens, 1–64 characters.";
export const environmentSuggestions = [
  "production",
  "staging",
  "development",
] as const;

const diacritics = /[̀-ͯ]/g;
const separators = /[^a-z0-9]+/g;
const edgeHyphens = /^-+|-+$/g;
const allowedCharacters = /[a-z0-9-]/g;
const uppercase = /[A-Z]/;

// "Payments EU (prod)" → "payments-eu-prod". Never longer than 64 characters.
export function slugify(value: string, max = 64) {
  return value
    .normalize("NFKD")
    .replace(diacritics, "")
    .toLowerCase()
    .replace(separators, "-")
    .replace(edgeHyphens, "")
    .slice(0, max)
    .replace(edgeHyphens, "");
}

function describeCharacter(character: string) {
  if (character === " ") {
    return "spaces";
  }
  if (uppercase.test(character)) {
    return "uppercase letters";
  }
  return `“${character}”`;
}

// Explains why an identifier would fail the hub's ^[a-z0-9-]{1,64}$ rule.
export function idProblem(id: string, reserved: readonly string[] = []) {
  if (!id) {
    return "Required.";
  }
  const invalid = [
    ...new Set([...id.replace(allowedCharacters, "")].map(describeCharacter)),
  ];
  if (invalid.length) {
    return `Remove ${invalid.slice(0, 4).join(", ")}.`;
  }
  if (id.length > 64) {
    return `Use at most 64 characters (currently ${id.length}).`;
  }
  if (reserved.includes(id)) {
    return `“${id}” is reserved. Choose another ID.`;
  }
  return;
}

export interface Enrollment {
  cluster: ClusterView["cluster"];
  enrollmentToken: string;
  expiresAt: string;
  kind: "new" | "recover";
}

// The hub's issue time, derived from its own expiry so both use one clock.
export function issuedAt(expiresAt: string) {
  return Date.parse(expiresAt) - enrollmentLifetimeMs;
}

type DeliveryState = "waiting" | "heartbeat" | "inventory";

export interface FirstDelivery {
  heartbeatAt?: string;
  servers: number;
  state: DeliveryState;
  version?: string;
}

function after(value: string | null | undefined, since: number) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && time >= since;
}

// Looks for hub receipts newer than the enrollment. A renewed cluster keeps
// its earlier heartbeat and inventory, which must not count as a new delivery.
export function firstDelivery(
  views: ClusterView[],
  clusterId: string,
  since: number
): FirstDelivery {
  const matches = views.filter((view) => view.cluster.id === clusterId);
  const view = matches.find((item) => after(item.cluster.heartbeatAt, since));
  if (!view) {
    return { state: "waiting", servers: 0 };
  }
  const inventory = matches.find((item) =>
    after(item.cluster.receivedAt, since)
  );
  return {
    state: inventory ? "inventory" : "heartbeat",
    servers: (inventory ?? view).inventory.entities.filter(
      (entity) => entity.kind === "Node"
    ).length,
    heartbeatAt: view.cluster.heartbeatAt ?? undefined,
    version: view.heartbeat.version || undefined,
  };
}

// How often the First heartbeat step checks the hub right now, or false once
// automatic checks have stopped. Both the query interval and the "Checking
// every N seconds" text come from here. Each stop leaves "Check now" in place.
export function deliveryCheckInterval({
  state,
  startedAt,
  expiresAt,
  heartbeatAt,
  now,
}: {
  state: DeliveryState;
  startedAt: number;
  expiresAt: string;
  heartbeatAt?: string;
  now: number;
}): number | false {
  if (state === "inventory") {
    return false;
  }
  if (state === "heartbeat") {
    const heartbeat = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
    const since = Math.max(
      startedAt,
      Number.isFinite(heartbeat) ? heartbeat : 0
    );
    return now - since < inventoryPatienceMs ? slowCheckMs : false;
  }
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || now >= expiry + expiryGraceMs) {
    return false;
  }
  return now - startedAt < slowCheckAfterMs ? fastCheckMs : slowCheckMs;
}

// "29:41" for a countdown; "0:00" once passed.
export function countdown(target: number, now: number) {
  const seconds = Math.max(0, Math.ceil((target - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

// "8 min", "under a minute"; for time left before an expiry.
export function minutesLeft(target: number, now: number) {
  const minutes = Math.floor((target - now) / 60_000);
  if (target <= now) {
    return "now";
  }
  return minutes < 1 ? "under a minute" : `${minutes} min`;
}

// "1m 05s" elapsed since `start`.
export function elapsed(start: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
