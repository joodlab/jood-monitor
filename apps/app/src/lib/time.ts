// Display helpers for source and receipt times. Values stay ISO strings until
// presentation; the display zone is an operator preference, never data.

export const timeZoneOptions = ["local", "UTC", "Asia/Riyadh"] as const;
export type TimeZonePreference = (typeof timeZoneOptions)[number];

export function resolveTimeZone(preference: TimeZonePreference) {
  if (preference !== "local") {
    return preference;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Intl formatters are expensive to construct and pages render hundreds of
// times every clock tick, so they are cached per kind and zone.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(
  kind: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions
) {
  const key = `${kind}|${timeZone}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en", { timeZone, ...options });
    formatters.set(key, cached);
  }
  return cached;
}

export function timeZoneLabel(timeZone: string, at = Date.now()) {
  try {
    const part = formatter("zone", timeZone, { timeZoneName: "short" })
      .formatToParts(at)
      .find((item) => item.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

// Epoch milliseconds, or undefined for missing, unparsable and zero-value
// timestamps (for example Go's 0001-01-01), which mean "never set".
export function knownTime(value: string | number | null | undefined) {
  if (value == null) {
    return;
  }
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? time : undefined;
}
const valid = knownTime;

export function formatClock(
  value: string | number | null | undefined,
  timeZone: string
) {
  const time = valid(value);
  if (time == null) {
    return "Unknown";
  }
  return formatter("clock", timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(time);
}

export function formatDateTime(
  value: string | number | null | undefined,
  timeZone: string
) {
  const time = valid(value);
  if (time == null) {
    return "Unknown";
  }
  return formatter("dateTime", timeZone, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(time);
}

export function formatDay(value: string | number, timeZone: string) {
  const time = valid(value);
  if (time == null) {
    return "Unknown";
  }
  return formatter("day", timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(time);
}

// Compact age such as "45s", "12m", "3h", "9d". Future values (clock skew)
// are labelled rather than shown as negative ages.
export function age(value: string | number | null | undefined, now: number) {
  const time = valid(value);
  if (time == null || !now) {
    return;
  }
  const seconds = Math.round((now - time) / 1000);
  if (seconds < -60) {
    return "in future";
  }
  const magnitude = Math.max(0, seconds);
  if (magnitude < 60) {
    return `${magnitude}s`;
  }
  if (magnitude < 3600) {
    return `${Math.floor(magnitude / 60)}m`;
  }
  if (magnitude < 86_400) {
    return `${Math.floor(magnitude / 3600)}h`;
  }
  return `${Math.floor(magnitude / 86_400)}d`;
}

export function relativeTime(
  value: string | number | null | undefined,
  now: number
) {
  const compact = age(value, now);
  if (!compact) {
    return "Unknown";
  }
  if (compact === "in future") {
    return "ahead of hub clock";
  }
  return compact === "0s" ? "just now" : `${compact} ago`;
}

function zoneOffset(time: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value])
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return wall - Math.floor(time / 1000) * 1000;
}

// "YYYY-MM-DDTHH:mm" as shown by a datetime-local input in the display zone.
export function toZonedInput(time: number, timeZone: string) {
  return new Date(time + zoneOffset(time, timeZone)).toISOString().slice(0, 16);
}

// Interprets a datetime-local value as wall-clock time in the display zone.
const zonedInput = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export function fromZonedInput(value: string, timeZone: string) {
  const wall = zonedInput.test(value) ? Date.parse(`${value}:00Z`) : Number.NaN;
  if (!Number.isFinite(wall)) {
    return;
  }
  let time = wall - zoneOffset(wall, timeZone);
  time = wall - zoneOffset(time, timeZone);
  return time;
}
