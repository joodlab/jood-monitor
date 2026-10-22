import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Attention } from "../lib/attention";
import { resourceStatus } from "../lib/infrastructure";
import { SeverityIcon, severityLabels } from "./severity";
import { TimeText } from "./time";

export interface AttentionActions {
  onCluster: (view: ClusterView) => void;
  onInspect: (view: ClusterView, entity: Entity) => void;
}

function open(item: Attention, actions: AttentionActions) {
  if (item.entity) {
    actions.onInspect(item.view, item.entity);
  } else {
    actions.onCluster(item.view);
  }
}

export function AttentionRow({
  item,
  actions,
  compact = false,
}: {
  item: Attention;
  actions: AttentionActions;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const members = item.scope === "workload" ? item.members : [];
  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-stretch">
        <button
          aria-label={`${severityLabels[item.severity]}: ${item.title}. ${item.location.join(", ")}`}
          className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
          onClick={() => open(item, actions)}
          type="button"
        >
          <SeverityIcon className="mt-0.5" severity={item.severity} />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-sm leading-snug">
              {item.title}
            </span>
            {item.reason && (
              <span className="mt-0.5 block text-muted-foreground text-xs">
                {item.reason}
              </span>
            )}
            <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
              {item.location.map((part) => (
                <span className="max-w-full truncate font-mono" key={part}>
                  {part}
                </span>
              ))}
              {item.entity && item.scope !== "workload" && !compact && (
                <span className="max-w-full truncate font-mono">
                  {item.entity.name}
                </span>
              )}
            </span>
          </span>
          {item.since && (
            <span className="shrink-0 text-muted-foreground text-xs">
              <TimeText label={item.since.label} value={item.since.at} />
            </span>
          )}
          <ChevronRight
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        </button>
        {members.length > 0 && !compact && (
          <Button
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} ${members.length} affected pods`}
            className="h-auto self-stretch rounded-none border-l px-3 text-xs"
            onClick={() => setExpanded((value) => !value)}
            variant="ghost"
          >
            {members.length} pod{members.length === 1 ? "" : "s"}
            <ChevronDown
              className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </Button>
        )}
      </div>
      {expanded && (
        <ul className="border-t bg-muted/20 py-1">
          {members.map((pod) => (
            <li key={pod.uid}>
              <button
                className="flex w-full items-center gap-3 px-4 py-2 pl-11 text-left text-xs outline-none hover:bg-muted/50 focus-visible:bg-muted/60"
                onClick={() => actions.onInspect(item.view, pod)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {pod.name}
                </span>
                <span className="text-muted-foreground">
                  {resourceStatus(pod)}
                  {pod.restarts ? ` · ${pod.restarts} restarts` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function AttentionList({
  items,
  actions,
  compact = false,
}: {
  items: Attention[];
  actions: AttentionActions;
  compact?: boolean;
}) {
  return (
    <ul>
      {items.map((item) => (
        <AttentionRow
          actions={actions}
          compact={compact}
          item={item}
          key={item.id}
        />
      ))}
    </ul>
  );
}
