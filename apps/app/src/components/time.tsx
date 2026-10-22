import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@jood-monitor/ui/tooltip";
import { cn } from "@jood-monitor/ui/utils";
import { useDisplay } from "../hooks/display";
import { freshness } from "../lib/metrics";
import { formatDateTime, relativeTime, timeZoneLabel } from "../lib/time";

// A time shown as a relative age with the exact time, zone and meaning in a
// tooltip. `label` says what the time measures (source, receipt, created).

export function TimeText({
  value,
  label,
  className,
  absolute = false,
}: {
  value?: string | null;
  label?: string;
  className?: string;
  absolute?: boolean;
}) {
  const { now, timeZone } = useDisplay();
  if (!value) {
    return <span className={className}>Unknown</span>;
  }
  const exact = `${formatDateTime(value, timeZone)} ${timeZoneLabel(timeZone, Date.parse(value))}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            className={cn("cursor-default tabular-nums", className)}
            dateTime={value}
          />
        }
      >
        {absolute || !now
          ? formatDateTime(value, timeZone)
          : relativeTime(value, now)}
      </TooltipTrigger>
      <TooltipContent>
        {label ? `${label}: ` : ""}
        {exact}
      </TooltipContent>
    </Tooltip>
  );
}

const freshnessTone: Record<string, string> = {
  fresh: "text-muted-foreground",
  stale: "text-warning-text",
  "clock skew": "text-warning-text",
  unknown: "text-muted-foreground",
};

// The age of the oldest observation in scope. Stale data is tinted and never
// presented as current, independent of the live stream connection.
export function DataAge({
  times,
  className,
}: {
  times: (string | null | undefined)[];
  className?: string;
}) {
  const { now, frozen, at, timeZone } = useDisplay();
  if (frozen && at) {
    return (
      <span className={cn("text-info-text text-xs", className)}>
        Saved observation · {formatDateTime(at, timeZone)}{" "}
        {timeZoneLabel(timeZone, Date.parse(at))}
      </span>
    );
  }
  const known = times
    .filter((value): value is string => !!value && Date.parse(value) >= 0)
    .sort();
  if (!(now && known.length)) {
    return (
      <span className={cn("text-muted-foreground text-xs", className)}>
        Awaiting observations
      </span>
    );
  }
  const oldest = known[0];
  const state = freshness(oldest, now);
  return (
    <span className={cn("text-xs", freshnessTone[state], className)}>
      Observed <TimeText label="Oldest observation in view" value={oldest} />
      {state === "stale" && " · stale"}
    </span>
  );
}
