import { timestampNano } from "./time";

// Outbox stamps lead with the observation's exact source nanoseconds; imported
// historical observations append ":<observationId>".
export function newestPendingStamp(stamps: string[], at: string) {
  const limit = timestampNano(at);
  let best: { nano: bigint; stamp: string } | null = null;
  for (const stamp of stamps) {
    const nano = BigInt(stamp.split(":")[0]);
    if (
      nano <= limit &&
      (!best || nano > best.nano || (nano === best.nano && stamp > best.stamp))
    ) {
      best = { nano, stamp };
    }
  }
  return best?.stamp ?? null;
}

// The newer source time wins. A tie keeps the archived copy, which is the same
// observation once the archival writer has published it.
export function newerObservation<
  T extends { inventory: { sourceTime: string } },
>(archived: T | null, pending: T | null) {
  if (!(archived && pending)) {
    return archived ?? pending;
  }
  return timestampNano(pending.inventory.sourceTime) >
    timestampNano(archived.inventory.sourceTime)
    ? pending
    : archived;
}
