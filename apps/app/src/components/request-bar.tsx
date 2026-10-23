import { cn } from "@jood-monitor/ui/utils";
import {
  type RequestShare,
  type RequestTone,
  requestReading,
} from "../lib/resource-servers";

// Neutral below 90% so requests do not read as measured load.
const tones: Record<RequestTone, string> = {
  normal: "bg-muted-foreground/60",
  full: "bg-warning",
  overcommitted: "bg-destructive",
  unknown: "",
};

// Configured requests against allocatable: what the scheduler reserved, not
// what is used. Overcommit is named; an unknown share shows a dash and the
// reason, never 0%.
export function RequestBar({
  label,
  share,
  format,
  compact = false,
  stale = false,
}: {
  label: string;
  share: RequestShare;
  // Unit formatter for the amounts, e.g. compactCpu or compactMemory.
  format: (value?: number) => string;
  // Compact rows carry the amounts or reason as hover and screen-reader text.
  compact?: boolean;
  // Requests come from the inventory; a stale one is drawn grey.
  stale?: boolean;
}) {
  const reading = requestReading(share, format);
  const unknown = reading.tone === "unknown";
  const note = `Configured requests, not usage${stale ? ", last reported" : ""}: ${reading.text}`;
  return (
    <div
      className={cn("min-w-0 space-y-1.5", stale && "grayscale")}
      title={compact ? note : undefined}
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span
          className={cn(
            "tabular-nums",
            unknown ? "text-muted-foreground" : "font-medium"
          )}
        >
          {reading.value}
        </span>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "h-1.5 overflow-hidden rounded-full",
          unknown
            ? "border border-muted-foreground/40 border-dashed"
            : "bg-muted"
        )}
      >
        {share.percent != null && (
          <div
            className={cn("h-full rounded-full", tones[reading.tone])}
            style={{ width: `${Math.min(100, Math.max(0, share.percent))}%` }}
          />
        )}
      </div>
      {compact ? (
        <span className="sr-only">{note}</span>
      ) : (
        <p
          className={cn(
            "text-muted-foreground text-xs tabular-nums",
            // Reasons and overcommit wrap rather than lose their message.
            !(unknown || reading.tone === "overcommitted") && "truncate"
          )}
          title={reading.text}
        >
          {reading.text}
        </p>
      )}
    </div>
  );
}
