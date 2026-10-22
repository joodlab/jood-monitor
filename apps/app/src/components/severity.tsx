import { cn } from "@jood-monitor/ui/utils";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { Severity } from "../lib/attention";

// Severity is always conveyed by icon shape and text, not colour alone.

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
  className,
}: {
  severity?: Severity;
  className?: string;
}) {
  if (!severity) {
    return (
      <CircleCheck
        aria-label="No problems"
        className={cn("size-4 text-success-text", className)}
      />
    );
  }
  const Icon = icons[severity];
  return (
    <Icon
      aria-label={severityLabels[severity]}
      className={cn("size-4 shrink-0", tones[severity], className)}
    />
  );
}

export function severityTone(severity?: Severity) {
  return severity ? tones[severity] : "text-success-text";
}
