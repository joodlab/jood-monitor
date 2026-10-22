import { cn } from "@jood-monitor/ui/utils";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Info,
  TriangleAlert,
} from "lucide-react";
import type { Severity } from "../lib/attention";

// Severity is always conveyed by icon shape and text, not colour alone.
// "No problems" (green) needs the caller to assert observed coverage; without
// it the icon stays neutral, because missing data is never healthy.

const icons = {
  critical: CircleAlert,
  warning: TriangleAlert,
  info: Info,
};
const tones: Record<Severity, string> = {
  critical: "text-destructive-text",
  warning: "text-warning-text",
  info: "text-info-text",
};
export const severityLabels: Record<Severity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

export function SeverityIcon({
  severity,
  covered = false,
  decorative = false,
  className,
}: {
  severity?: Severity;
  // Inventory was observed for everything this icon summarises.
  covered?: boolean;
  // Adjacent text already states the severity.
  decorative?: boolean;
  className?: string;
}) {
  const a11y = (label: string) =>
    decorative ? { "aria-hidden": true } : { "aria-label": label, role: "img" };
  if (!severity) {
    return covered ? (
      <CircleCheck
        {...a11y("No problems")}
        className={cn("size-4 shrink-0 text-success-text", className)}
      />
    ) : (
      <CircleDashed
        {...a11y("No observation")}
        className={cn("size-4 shrink-0 text-muted-foreground", className)}
      />
    );
  }
  const Icon = icons[severity];
  return (
    <Icon
      {...a11y(severityLabels[severity])}
      className={cn("size-4 shrink-0", tones[severity], className)}
    />
  );
}

export function severityTone(severity?: Severity, covered = false) {
  if (severity) {
    return tones[severity];
  }
  return covered ? "text-success-text" : "text-muted-foreground";
}
