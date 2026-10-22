import type { ClusterView } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useDisplay } from "../hooks/display";
import {
  type Attention,
  attentionSummary,
  observationCoverage,
  type Severity,
} from "../lib/attention";
import { type AttentionActions, AttentionList } from "./attention-list";
import { SeverityIcon } from "./severity";
import { Widget } from "./widget-card";

// The "Needs attention" widget: live problems with a severity filter, a
// bounded list that expands in place, and finished-pod history collapsed
// beneath. It replaces the separate Attention page.

const PREVIEW = 6;

const filters: { id: Severity | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "critical", label: "Critical" },
  { id: "warning", label: "Warning" },
  { id: "info", label: "Info" },
];

type Coverage = ReturnType<typeof observationCoverage>;

// Problems are reported before coverage: a heartbeat without inventory is
// still an observation that needs attention.
function heading(coverage: Coverage, problems: number) {
  if (problems) {
    return "Needs attention";
  }
  return coverage.observed
    ? "No problems observed"
    : "No observations in scope";
}

// Shown when nothing at the chosen severity remains. "No problems" (green)
// needs every cluster in scope observed; otherwise the state is neutral.
function NothingVisible({
  live,
  coverage,
  frozen,
}: {
  live: number;
  coverage: Coverage;
  frozen: boolean;
}) {
  let text = `No readiness, pressure${frozen ? "" : ", observer or inventory freshness"} problems in the observed ${coverage.total === 1 ? "cluster" : "clusters"}.`;
  if (live) {
    text =
      "No problems at this severity. Choose another filter to see the rest.";
  } else if (coverage.missing) {
    const without = frozen ? "a saved observation" : "inventory";
    text = coverage.observed
      ? `No problems in the ${coverage.observed} observed ${coverage.observed === 1 ? "cluster" : "clusters"}; ${coverage.missing} without ${without} cannot be evaluated.`
      : `Nothing is ${frozen ? "saved for this time" : "observed yet"}, so problems cannot be evaluated.`;
  }
  return (
    <p className="flex items-start gap-2 px-4 py-5 text-muted-foreground text-sm sm:px-5">
      <SeverityIcon
        className="mt-0.5"
        covered={!(live || coverage.missing)}
        decorative
      />
      {text}
    </p>
  );
}

function SeverityFilter({
  value,
  counts,
  onChange,
}: {
  value: Severity | "all";
  counts: Record<string, number>;
  onChange: (value: Severity | "all") => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of toggle buttons, not a form fieldset.
    <div
      aria-label="Filter problems by severity"
      className="flex flex-wrap gap-1"
      role="group"
    >
      {filters.map((filter) => (
        <Button
          aria-pressed={value === filter.id}
          className="h-8 gap-1.5 rounded-full px-3 text-xs"
          key={filter.id}
          onClick={() => onChange(filter.id)}
          size="sm"
          variant={value === filter.id ? "secondary" : "ghost"}
        >
          {filter.id !== "all" && (
            <SeverityIcon
              className="size-3.5"
              decorative
              severity={filter.id}
            />
          )}
          {filter.label}
          <span className="text-muted-foreground tabular-nums">
            {counts[filter.id]}
          </span>
        </Button>
      ))}
    </div>
  );
}

function FinishedHistory({
  items,
  actions,
}: {
  items: Attention[];
  actions: AttentionActions;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t">
      <button
        aria-expanded={open}
        className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="min-w-0">
          <span className="block font-medium text-sm">
            Finished pods with failures · {items.length}
          </span>
          <span className="mt-0.5 block text-muted-foreground text-xs">
            Stopped pods retained by Kubernetes until deleted. History, not a
            current outage, and not counted above.
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open && (
        <div className="border-t bg-muted/20">
          <AttentionList actions={actions} items={items} />
        </div>
      )}
    </div>
  );
}

function severityText(summary: ReturnType<typeof attentionSummary>) {
  return [
    summary.critical && `${summary.critical} critical`,
    summary.warning &&
      `${summary.warning} warning${summary.warning === 1 ? "" : "s"}`,
    summary.info && `${summary.info} info`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function AttentionWidget({
  attention,
  views,
  actions,
  className,
}: {
  attention: Attention[];
  // Clusters in scope, after the workspace and cluster filters.
  views: ClusterView[];
  actions: AttentionActions;
  className?: string;
}) {
  const { frozen, referenceTime } = useDisplay();
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [expanded, setExpanded] = useState(false);
  const summary = attentionSummary(attention);
  const coverage = observationCoverage(views, referenceTime);
  const live = attention.filter((item) => !item.terminal);
  const finished = attention.filter((item) => item.terminal);
  const visible = live.filter(
    (item) => severity === "all" || item.severity === severity
  );
  const shown = expanded ? visible : visible.slice(0, PREVIEW);
  const counts: Record<string, number> = {
    all: live.length,
    critical: summary.critical,
    warning: summary.warning,
    info: summary.info,
  };
  return (
    <Widget
      action={
        live.length > 0 && (
          <SeverityFilter
            counts={counts}
            onChange={(next) => {
              setSeverity(next);
              setExpanded(false);
            }}
            value={severity}
          />
        )
      }
      className={className}
      description={
        frozen
          ? "Conditions in the saved observation. Observer heartbeats are not retained historically and are not evaluated."
          : "Observed now, one row per cluster, server, workload or unowned pod. Select a row to inspect it."
      }
      title={
        <>
          <SeverityIcon
            covered={!coverage.missing}
            decorative
            severity={summary.worst}
          />
          {heading(coverage, live.length)}
          {live.length > 0 && (
            <span className="font-normal text-muted-foreground text-sm">
              {severityText(summary)}
            </span>
          )}
        </>
      }
    >
      {shown.length > 0 ? (
        <AttentionList actions={actions} items={shown} />
      ) : (
        <NothingVisible
          coverage={coverage}
          frozen={frozen}
          live={live.length}
        />
      )}
      {visible.length > PREVIEW && (
        <div className="border-t px-2 py-1.5">
          <Button
            aria-expanded={expanded}
            className="h-8 w-full text-xs"
            onClick={() => setExpanded((value) => !value)}
            size="sm"
            variant="ghost"
          >
            {expanded
              ? "Show fewer problems"
              : `Show all ${visible.length} problems`}
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-180"
              )}
            />
          </Button>
        </div>
      )}
      {finished.length > 0 && (
        <FinishedHistory actions={actions} items={finished} />
      )}
    </Widget>
  );
}
