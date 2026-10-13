import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Card, CardContent } from "@jood-monitor/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@jood-monitor/ui/tooltip";
import { ArrowUpRight, Server } from "lucide-react";
import {
  compactCpu,
  compactMemory,
  filterResources,
  percent,
  podReady,
  resourceStatus,
  summarize,
} from "../lib/infrastructure";
import { freshness, observedUsage } from "../lib/metrics";
import { MetricBar, StatusBadge } from "./resource-status";

export function Servers({
  views,
  search,
  onInspect,
  referenceTime,
}: {
  views: ClusterView[];
  search: string;
  onInspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
}) {
  const nodes = filterResources(views, search).filter(
    ({ entity }) => entity.kind === "Node"
  );
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {nodes.map(({ view, entity }) => {
        const summary = summarize(view, entity, referenceTime);
        const cpu = observedUsage(view, entity, "cpu", referenceTime);
        const memory = observedUsage(view, entity, "memory", referenceTime);
        const stale =
          freshness(view.inventory.sourceTime, referenceTime) !== "fresh";
        return (
          <Card
            className="gap-0 overflow-hidden py-0 transition-colors hover:border-ring/40"
            key={`${view.cluster.id}:${entity.uid}`}
          >
            <div className="flex items-start gap-2 border-b p-4">
              <Server className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <Button
                  className="h-auto max-w-full justify-start p-0 font-mono text-xs"
                  onClick={() => onInspect(view, entity)}
                  variant="link"
                >
                  <span className="truncate">{entity.name}</span>
                  <ArrowUpRight className="size-3 shrink-0" />
                </Button>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {entity.roles?.join(", ") || "Node"} · {view.cluster.name}
                </p>
              </div>
              <StatusBadge entity={entity} stale={stale} />
            </div>
            <CardContent className="space-y-4 p-4">
              <div className="grid grid-cols-2 gap-4">
                <MetricBar
                  detail={`${compactCpu(cpu)} / ${compactCpu(entity.capacityCpu ?? undefined)}`}
                  label="CPU"
                  value={percent(cpu, entity.capacityCpu)}
                />
                <MetricBar
                  detail={`${compactMemory(memory)} / ${compactMemory(entity.capacityMemory ?? undefined)}`}
                  label="Memory"
                  value={percent(memory, entity.capacityMemory)}
                />
              </div>
              <div>
                <div className="mb-2 flex justify-between text-[11px] text-muted-foreground">
                  <span>Pod placement</span>
                  <span>{summary.pods.length} pods</span>
                </div>
                <div className="flex min-h-6 flex-wrap gap-1">
                  {summary.pods.slice(0, 48).map((pod) => (
                    <Tooltip key={pod.uid}>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Inspect pod ${pod.name}`}
                            className={`size-4 min-w-0 rounded-[3px] p-0 ${podTone(pod)}`}
                            onClick={() => onInspect(view, pod)}
                            variant="outline"
                          />
                        }
                      />
                      <TooltipContent>
                        <p className="font-medium">{pod.name}</p>
                        <p>
                          {resourceStatus(pod)} ·{" "}
                          {compactMemory(
                            observedUsage(view, pod, "memory", referenceTime)
                          )}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                  {summary.pods.length > 48 && (
                    <span className="text-[10px] text-muted-foreground">
                      +{summary.pods.length - 48}
                    </span>
                  )}
                </div>
              </div>
              <p className="truncate border-t pt-3 font-mono text-[10px] text-muted-foreground">
                {entity.addresses?.join(", ") || "Address unavailable"} ·{" "}
                {entity.capacityCpu ?? "—"} vCPU ·{" "}
                {compactMemory(entity.capacityMemory ?? undefined)}
              </p>
              <Button
                className="h-7 w-full"
                onClick={() => onInspect(view, entity)}
                size="sm"
                variant="outline"
              >
                Inspect server and pods
              </Button>
            </CardContent>
          </Card>
        );
      })}
      {!nodes.length && (
        <p className="col-span-full rounded-lg border border-dashed p-12 text-center text-muted-foreground text-sm">
          No observed servers match these filters.
        </p>
      )}
    </div>
  );
}

function podTone(pod: Entity) {
  const ready = podReady(pod);
  if (ready == null) {
    return "bg-muted";
  }
  return ready ? "bg-emerald-500/25" : "bg-amber-500/25";
}
