// What this page has seen of an observer's delivery totals. The observer
// reports dropped batches and rejected points only as running totals since
// its process started, never when each happened, so a rise is known only
// between two fresh heartbeats this page saw, and a lower total means the
// counter reset: the observer restarted from zero (one observer runs at a
// time), so every event in the new total happened after the last heartbeat
// seen before it. Times named "HeartbeatAt" are the hub's receipt of that
// heartbeat; `at` times are this page's clock, used only for its own window.

export interface CounterWatch {
  // The first heartbeat seen with new events: a higher total than the one
  // before it, or a counter reset with a total above zero.
  firstHigherHeartbeatAt?: string;
  // The total in the first fresh heartbeat this page saw, and when.
  firstSeen: { value: number; at: number };
  // The latest heartbeat seen with a higher total. A reset's new events
  // leave it unchanged, so the reset stays the latest change.
  lastHigherHeartbeatAt?: string;
  lastValue: number;
  // The latest heartbeat seen with a lower total, and the total before it.
  resetAt?: string;
  resetFrom?: number;
  // When this page saw the latest new events.
  risenAt?: number;
  // Every event seen since the page opened: each increase, and after a
  // counter reset the whole new total, which counts from zero.
  risenBy: number;
}

export interface DeliveryWatch {
  // The observer's local spool held data in the latest heartbeat.
  backlog: boolean;
  dropped: CounterWatch;
  heartbeatAt: string;
  rejectedPoints: CounterWatch;
}

export interface DeliveryReading {
  dropped: number;
  // The heartbeat is fresh; stale and skewed reports are not watched.
  fresh: boolean;
  heartbeatAt: string | null | undefined;
  queueBytes: number;
  rejectedPoints: number;
}

// A rise seen this recently still counts as current.
const recentRiseMs = 15 * 60_000;

function nextCounter(
  previous: CounterWatch | undefined,
  value: number,
  heartbeatAt: string,
  nowMs: number
): CounterWatch {
  if (!previous) {
    return { firstSeen: { value, at: nowMs }, lastValue: value, risenBy: 0 };
  }
  if (value > previous.lastValue) {
    return {
      ...previous,
      lastValue: value,
      risenBy: previous.risenBy + value - previous.lastValue,
      firstHigherHeartbeatAt: previous.firstHigherHeartbeatAt ?? heartbeatAt,
      lastHigherHeartbeatAt: heartbeatAt,
      risenAt: nowMs,
    };
  }
  if (value < previous.lastValue) {
    const reset = {
      ...previous,
      lastValue: value,
      resetAt: heartbeatAt,
      resetFrom: previous.lastValue,
    };
    // The new total counted from zero after the restart, so all of it is new.
    if (value === 0) {
      return reset;
    }
    return {
      ...reset,
      risenBy: previous.risenBy + value,
      firstHigherHeartbeatAt: previous.firstHigherHeartbeatAt ?? heartbeatAt,
      risenAt: nowMs,
    };
  }
  return previous;
}

// The watch after one more snapshot of a cluster. Only a fresh heartbeat
// newer than the last one seen moves it; anything else returns `previous`
// unchanged, so repeated renders of one heartbeat count it once.
export function nextWatch(
  previous: DeliveryWatch | undefined,
  reading: DeliveryReading,
  nowMs: number
): DeliveryWatch | undefined {
  const { heartbeatAt } = reading;
  const time = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  if (
    !(reading.fresh && heartbeatAt && Number.isFinite(time)) ||
    (previous && time <= Date.parse(previous.heartbeatAt))
  ) {
    return previous;
  }
  return {
    heartbeatAt,
    backlog: reading.queueBytes > 0,
    dropped: nextCounter(
      previous?.dropped,
      reading.dropped,
      heartbeatAt,
      nowMs
    ),
    rejectedPoints: nextCounter(
      previous?.rejectedPoints,
      reading.rejectedPoints,
      heartbeatAt,
      nowMs
    ),
  };
}

// Whether this page saw the total rise within the recent window.
export function recentRise(counter: CounterWatch | undefined, nowMs: number) {
  return counter?.risenAt != null && nowMs - counter.risenAt <= recentRiseMs;
}

// The latest change this page saw: a rise, a reset, or none.
export function latestChange(counter: CounterWatch) {
  const rise = counter.lastHigherHeartbeatAt
    ? Date.parse(counter.lastHigherHeartbeatAt)
    : Number.NEGATIVE_INFINITY;
  const reset = counter.resetAt
    ? Date.parse(counter.resetAt)
    : Number.NEGATIVE_INFINITY;
  if (reset > rise) {
    return "reset";
  }
  return counter.risenBy > 0 ? "rise" : undefined;
}
