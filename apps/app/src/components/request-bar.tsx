import { cn } from "@jood-monitor/ui/utils";
import { percentage } from "../lib/infrastructure";
import type { RequestShare } from "../lib/resource-servers";

// Configured requests against allocatable: what the scheduler reserved, not
// what is used. Overcommit shows its true percentage; an unknown share shows
// a dash and the reason, never 0%.
export function RequestBar({
  label,
  share,
  format,
  compact = false,
}: {
  label: string;
  share: RequestShare;
  // Unit formatter for the amounts, e.g. compactCpu or compactMemory.
  format: (value?: number) => string;
  // Compact rows carry the amounts or reason as hover and screen-reader text.
  compact?: boolean;
}) {
  const value = share.percent;
  const text = requestText(share, format);
  const note = `Configured requests, not usage: ${text}`;
  return (
    <div className="min-w-0 space-y-1.5" title={compact ? note : undefined}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span
          className={cn(
            "tabular-nums",
            value == null ? "text-muted-foreground" : "font-medium"
          )}
        >
          {value == null ? "—" : percentage(value)}
        </span>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "h-1.5 overflow-hidden rounded-full",
          value == null
            ? "border border-muted-foreground/40 border-dashed"
            : "bg-muted"
        )}
      >
        {value != null && (
          <div
            className={cn("h-full rounded-full", requestTone(value))}
            style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
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
            value != null && value <= 100 && "truncate"
          )}
        >
          {text}
        </p>
      )}
    </div>
  );
}

function requestText(share: RequestShare, format: (value?: number) => string) {
  if (share.percent == null) {
    return share.unknown ?? "Unknown";
  }
  const amounts = `${format(share.requested)} / ${format(share.allocatable)}`;
  return share.percent > 100 ? `Overcommitted · ${amounts}` : amounts;
}

// Neutral below 90% so requests do not read as measured load.
function requestTone(value: number) {
  if (value > 100) {
    return "bg-destructive";
  }
  return value >= 90 ? "bg-warning" : "bg-muted-foreground/60";
}
