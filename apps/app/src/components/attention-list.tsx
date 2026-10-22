import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
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

// Where and since when, without opening the row: cluster, namespace or node,
// the subject's name, and an evidence time labelled with what it measures.
function contextParts(item: Attention) {
  const parts: { key: string; node: ReactNode }[] = item.location.map(
    (part) => ({
      key: `location:${part}`,
      node: <span className="truncate">{part}</span>,
    })
  );
  if (item.entity && item.scope !== "workload") {
    parts.push({
      key: "subject",
      node: (
        <span className="truncate font-mono text-foreground/80">
          {item.entity.name}
        </span>
      ),
    });
  }
  if (item.since) {
    parts.push({
      key: "since",
      node: (
        <span className="whitespace-nowrap">
          {item.since.label}{" "}
          <TimeText label={item.since.label} value={item.since.at} />
        </span>
      ),
    });
  }
  return parts;
}

// Screen-reader punctuation, so the row's name (built from its content) reads
// as separate phrases rather than run-together words.
function Spoken({ text }: { text: string }) {
  return <span className="sr-only">{text}</span>;
}

function AttentionRow({
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
        {/* The accessible name is the row's visible content: severity, title,
            reason, location, subject and evidence time. */}
        <button
          className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => open(item, actions)}
          type="button"
        >
          <Spoken text={`${severityLabels[item.severity]}: `} />
          <SeverityIcon
            className="mt-0.5"
            decorative
            severity={item.severity}
          />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-sm leading-snug">
              {item.title}
              <Spoken text=". " />
            </span>
            {item.reason && (
              <span className="mt-0.5 block text-muted-foreground text-xs">
                {item.reason}
                <Spoken text=". " />
              </span>
            )}
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
              {contextParts(item).map((part, index) => (
                <span
                  className="flex max-w-full items-center gap-1.5"
                  key={part.key}
                >
                  {index > 0 && (
                    <>
                      <Spoken text=", " />
                      <span aria-hidden>·</span>
                    </>
                  )}
                  {part.node}
                </span>
              ))}
            </span>
          </span>
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
                className="flex w-full items-center gap-3 px-4 py-2 pl-11 text-left text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
