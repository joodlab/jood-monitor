import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import { ChevronDown, CircleCheck } from "lucide-react";
import { useState } from "react";
import { useDisplay } from "../hooks/display";
import {
  type Attention,
  attentionSummary,
  type Severity,
} from "../lib/attention";
import { type AttentionActions, AttentionList } from "./attention-list";
import { EmptyState } from "./page";
import { SeverityIcon } from "./severity";

const filters: { id: Severity | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "critical", label: "Critical" },
  { id: "warning", label: "Warning" },
  { id: "info", label: "Info" },
];

export function AttentionPage({
  attention,
  actions,
}: {
  attention: Attention[];
  actions: AttentionActions;
}) {
  const { frozen } = useDisplay();
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [showFinished, setShowFinished] = useState(false);
  const summary = attentionSummary(attention);
  const live = attention.filter((item) => !item.terminal);
  const finished = attention.filter((item) => item.terminal);
  const visible = live.filter(
    (item) => severity === "all" || item.severity === severity
  );
  const counts: Record<string, number> = {
    all: live.length,
    critical: summary.critical,
    warning: summary.warning,
    info: summary.info,
  };
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-sm">
        {frozen
          ? "Conditions recorded in the saved observation. Observer heartbeat freshness is not retained historically and is not evaluated."
          : "Problems observed right now, one row per cluster, node, workload or unowned pod. Select a row to inspect it."}
      </p>
      <div
        aria-label="Filter by severity"
        className="flex flex-wrap gap-2"
        role="toolbar"
      >
        {filters.map((filter) => (
          <Button
            aria-pressed={severity === filter.id}
            className="h-8 gap-1.5 text-xs"
            key={filter.id}
            onClick={() => setSeverity(filter.id)}
            size="sm"
            variant={severity === filter.id ? "secondary" : "outline"}
          >
            {filter.id !== "all" && (
              <SeverityIcon className="size-3.5" severity={filter.id} />
            )}
            {filter.label}
            <span className="text-muted-foreground tabular-nums">
              {counts[filter.id]}
            </span>
          </Button>
        ))}
      </div>
      {visible.length > 0 ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          <AttentionList actions={actions} items={visible} />
        </div>
      ) : (
        <EmptyState
          description={
            live.length
              ? "No problems with this severity. Choose another filter to see the rest."
              : `No readiness, pressure${frozen ? "" : ", observer or inventory freshness"} problems were observed.`
          }
          icon={CircleCheck}
          title={
            live.length ? "Nothing at this severity" : "No problems observed"
          }
        />
      )}
      {finished.length > 0 && (
        <section className="overflow-hidden rounded-lg border bg-card">
          <button
            aria-expanded={showFinished}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
            onClick={() => setShowFinished((value) => !value)}
            type="button"
          >
            <span>
              <span className="block font-medium text-sm">
                Finished pods with failures · {finished.length}
              </span>
              <span className="mt-0.5 block text-muted-foreground text-xs">
                These pods stopped and are retained by Kubernetes until deleted.
                They are history, not a current outage, and are excluded from
                the counts above.
              </span>
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 transition-transform",
                showFinished && "rotate-180"
              )}
            />
          </button>
          {showFinished && (
            <div className="border-t">
              <AttentionList actions={actions} items={finished} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
