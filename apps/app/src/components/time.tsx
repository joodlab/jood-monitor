import type { ClusterView } from "@jood-monitor/api-client";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@jood-monitor/ui/tooltip";
import { cn } from "@jood-monitor/ui/utils";
import { type MouseEvent, type PointerEvent, useRef, useState } from "react";
import { useDisplay } from "../hooks/display";
import { coverageGap, dataAge } from "../lib/attention";
import {
  formatDateTime,
  knownTime,
  relativeTime,
  timeZoneLabel,
} from "../lib/time";

// A time shown as a relative age with the exact time, zone and meaning in a
// tooltip. `label` says what the time measures (source, receipt, created).
// The exact time is also in the accessible text; on its own the time is a
// tab stop (focus opens the tooltip) and a tap toggles it on touch screens.
// Inside another control (a row button or link) it adds neither, so the
// control keeps one tab stop and its own click.

const interactiveAncestor =
  "button, a[href], [role=button], [role=link], [role=option], summary";

function insideControl(element: Element | null) {
  return !!element?.parentElement?.closest(interactiveAncestor);
}

// Stable ref callback, so it runs once when the element mounts.
function focusableUnlessNested(element: HTMLElement | null) {
  if (element && !insideControl(element)) {
    element.tabIndex = 0;
  }
}

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
  const [open, setOpen] = useState(false);
  const pointer = useRef("");
  const known = knownTime(value);
  if (!value || known == null) {
    return <span className={className}>Unknown</span>;
  }
  const exact = `${formatDateTime(value, timeZone)} ${timeZoneLabel(timeZone, known)}`;
  const tap = (event: MouseEvent<HTMLElement>) => {
    if (
      pointer.current &&
      pointer.current !== "mouse" &&
      !insideControl(event.currentTarget)
    ) {
      // The tap belongs to the time, not to a clickable row around it.
      event.stopPropagation();
      setOpen((current) => !current);
    }
  };
  return (
    <Tooltip onOpenChange={setOpen} open={open}>
      <TooltipTrigger
        closeOnClick={false}
        onClick={tap}
        onPointerDown={(event: PointerEvent<HTMLElement>) => {
          pointer.current = event.pointerType;
        }}
        ref={focusableUnlessNested}
        render={
          <time
            className={cn(
              "cursor-default rounded-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
              className
            )}
            dateTime={value}
          />
        }
      >
        {absolute || !now
          ? formatDateTime(value, timeZone)
          : relativeTime(value, now)}
        <span className="sr-only">{` (${label ? `${label}: ` : ""}${exact})`}</span>
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

// The age of the oldest inventory sample in scope, on the observer's source
// clock, plus how many clusters have nothing to show. Stale data and gaps are
// tinted and never presented as current, independent of the live stream.
export function DataAge({
  views,
  className,
}: {
  views: ClusterView[];
  className?: string;
}) {
  const { now, frozen, at, referenceTime, timeZone } = useDisplay();
  const age = dataAge(views, referenceTime, frozen);
  const gap = coverageGap(age, frozen);
  const gapText = gap ? ` · ${gap}` : "";
  if (frozen && at) {
    return (
      <span
        className={cn(
          "text-xs",
          gap ? "text-warning-text" : "text-info-text",
          className
        )}
      >
        Saved observation · {formatDateTime(at, timeZone)}{" "}
        {timeZoneLabel(timeZone, Date.parse(at))}
        {gapText}
      </span>
    );
  }
  if (!(now && age.oldest)) {
    return (
      <span
        className={cn(
          "text-xs",
          now && gap ? "text-warning-text" : "text-muted-foreground",
          className
        )}
      >
        Awaiting observations{now ? gapText : ""}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "text-xs",
        gap ? "text-warning-text" : freshnessTone[age.state],
        className
      )}
    >
      Inventory sampled{" "}
      <TimeText
        label="Oldest inventory source time in view"
        value={age.oldest}
      />
      {age.state === "stale" && " · stale"}
      {gapText}
    </span>
  );
}
