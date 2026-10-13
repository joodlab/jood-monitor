const RFC3339 = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/;

// Keep source time's complete nanoseconds. Dates are used only for presentation or cutoffs.
export function timestampNano(value: string) {
  const match = RFC3339.exec(value);
  if (!match) {
    throw new Error("UTC RFC3339 timestamp required");
  }
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== match[1]
  ) {
    throw new Error("invalid timestamp");
  }
  return (
    BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))
  );
}

export function nanoTimestamp(value: bigint | string) {
  const nano = BigInt(value);
  const seconds = nano / 1_000_000_000n;
  const fraction = (nano % 1_000_000_000n).toString().padStart(9, "0");
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
}

export function bucketStart(nano: string, seconds = 300) {
  const width = BigInt(seconds) * 1_000_000_000n;
  return nanoTimestamp((BigInt(nano) / width) * width);
}

export function completeCutoff(now: number, diagnostic: boolean) {
  const retention = diagnostic ? 86_400_000 : 7 * 86_400_000;
  return (
    BigInt(Math.ceil((now - retention) / 3_600_000) * 3_600_000) * 1_000_000n
  );
}
