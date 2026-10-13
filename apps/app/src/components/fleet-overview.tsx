import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@jood-monitor/ui/card";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import {
  attentionItems,
  compactCpu,
  compactMemory,
  percent,
  percentage,
  podReady,
} from "../lib/infrastructure";
import { freshness, nodeTotals } from "../lib/metrics";
import { MetricBar } from "./resource-status";
import { Resources } from "./resources";

export function FleetOverview({
  views,
  onInspect,
  onCluster,
  referenceTime,
  frozen = false,
}: {
  views: ClusterView[];
  onInspect: (view: ClusterView, entity: Entity) => void;
  onCluster: (view: ClusterView) => void;
  referenceTime: number;
  frozen?: boolean;
}) {
  const attention = attentionItems(views, referenceTime, frozen);
  const totals = nodeTotals(views, referenceTime);
  const pods = views.flatMap((view) =>
    view.inventory.entities.filter(
      (entity) =>
        entity.kind === "Pod" &&
        !["Succeeded", "Completed", "Failed"].includes(entity.status)
    )
  );
  const knownReadiness = pods.filter((pod) => podReady(pod) != null);
  const ready = pods.filter((pod) => podReady(pod) === true).length;
  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="flex items-center gap-2 font-medium text-sm">
            {attention.length ? (
              <TriangleAlert className="size-4 text-amber-500" />
            ) : (
              <Check className="size-4 text-emerald-500" />
            )}
            Needs attention{" "}
            <span className="text-muted-foreground">· {attention.length}</span>
          </h2>
          <span className="hidden text-[11px] text-muted-foreground sm:block">
            Observed conditions · click to investigate
          </span>
        </div>
        {attention.slice(0, 5).map((item) => (
          <Button
            className="flex h-auto w-full justify-start gap-4 rounded-none border-b px-4 py-3 text-left last:border-b-0"
            key={`${item.view.cluster.id}:${item.entity.uid}:${item.title}`}
            onClick={() => onInspect(item.view, item.entity)}
            variant="ghost"
          >
            <span
              className={`w-16 shrink-0 font-mono text-[10px] uppercase ${severityTone[item.severity]}`}
            >
              {item.severity}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-xs">
                {item.title}
              </span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {item.entity.name}
              </span>
            </span>
            <ArrowRight className="size-3 text-muted-foreground" />
          </Button>
        ))}
        {!attention.length && (
          <p className="px-4 py-4 text-muted-foreground text-sm">
            {views.length
              ? "No observed readiness, pressure, or freshness problems."
              : "Connect a cluster to receive observations."}
          </p>
        )}
      </div>
      <div className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Servers observed",
            value: `${totals.nodes}`,
            detail: `${totals.covered}/${totals.nodes} fresh resource sources`,
          },
          {
            label: "CPU · weighted usage",
            value: percentage(
              percent(totals.usedCpu, totals.coveredCpuCapacity)
            ),
            detail: `${compactCpu(totals.usedCpu)} · ${compactCpu(totals.capacityCpu)} capacity`,
          },
          {
            label: "Memory · weighted usage",
            value: percentage(
              percent(totals.usedMemory, totals.coveredMemoryCapacity)
            ),
            detail: `${compactMemory(totals.usedMemory)} · ${compactMemory(totals.capacityMemory)} capacity`,
          },
          {
            label: "Pods ready",
            value:
              knownReadiness.length === pods.length
                ? `${ready} / ${pods.length}`
                : "Unknown",
            detail:
              knownReadiness.length === pods.length
                ? "Kubernetes Ready condition"
                : `${pods.length} active pods · readiness unavailable`,
          },
        ].map((card) => (
          <div
            className="border-b p-4 last:border-b-0 sm:border-r lg:border-b-0"
            key={card.label}
          >
            <p className="text-[11px] text-muted-foreground">{card.label}</p>
            <p className="my-2 font-mono font-semibold text-2xl tracking-tight">
              {card.value}
            </p>
            <p className="truncate text-[10px] text-muted-foreground">
              {card.detail}
            </p>
          </div>
        ))}
      </div>
      {totals.covered < totals.nodes && (
        <p
          className="rounded-md border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-xs"
          role="status"
        >
          Weighted usage covers {totals.covered} fresh nodes. Missing or stale
          measurements stay unknown.
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {views.map((view) => {
          const summary = nodeTotals([view], referenceTime);
          return (
            <Card className="gap-3 py-4" key={view.cluster.id}>
              <CardHeader className="px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">{view.cluster.name}</CardTitle>
                  <Badge variant="outline">
                    {freshness(view.inventory.sourceTime, referenceTime)}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {view.cluster.workspaceId} · {view.cluster.environment}
                  {!frozen && ` · ${view.profile.name}`}
                </p>
              </CardHeader>
              <CardContent className="space-y-4 px-4">
                <div className="grid grid-cols-2 gap-4">
                  <MetricBar
                    label="CPU"
                    value={
                      summary.covered === summary.nodes
                        ? percent(summary.usedCpu, summary.capacityCpu)
                        : undefined
                    }
                  />
                  <MetricBar
                    label="Memory"
                    value={
                      summary.covered === summary.nodes
                        ? percent(summary.usedMemory, summary.capacityMemory)
                        : undefined
                    }
                  />
                </div>
                <Button
                  className="w-full justify-between"
                  onClick={() => onCluster(view)}
                  size="sm"
                  variant="outline"
                >
                  Explore {summary.nodes} servers
                  <ArrowRight className="size-3" />
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <div className="space-y-3">
        <h2 className="font-medium text-sm">Servers</h2>
        <Resources
          kinds={["Node"]}
          onInspect={onInspect}
          referenceTime={referenceTime}
          search=""
          views={views}
        />
      </div>
    </div>
  );
}

const severityTone = {
  critical: "text-rose-500",
  warning: "text-amber-500",
  info: "text-sky-500",
};
