import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@jood-monitor/ui/sheet";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Cpu, Database, Network, Server } from "lucide-react";
import { useEffect, useRef } from "react";
import { getHistoryFn } from "../functions/clusters";
import {
  compactCpu,
  compactMemory,
  owningWorkload,
  type ResourceSummary,
  readinessLabel,
  resourceStatus,
  summarize,
} from "../lib/infrastructure";
import {
  freshness,
  nodeProfileOutcome,
  observedUsage,
  usageName,
} from "../lib/metrics";
import { ResourceChart } from "./resource-chart";
import { StatusBadge } from "./resource-status";

export function ResourceInspector({
  inspected,
  onClose,
  onInspect,
  referenceTime,
  range,
  at,
  onCollection,
}: {
  inspected: { view: ClusterView; entity: Entity } | null;
  onClose: () => void;
  onInspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  range: string;
  at?: string;
  onCollection: (view: ClusterView, node?: Entity) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const inspectionKey = inspected
    ? `${inspected.view.cluster.id}:${inspected.entity.uid}`
    : "";
  useEffect(() => {
    if (inspectionKey) {
      panel.current?.scrollTo({ top: 0 });
    }
  }, [inspectionKey]);
  const cpu = useHistory(inspected, "cpu", range, at, referenceTime);
  const memory = useHistory(inspected, "memory", range, at, referenceTime);
  const view = inspected?.view;
  const entity = inspected?.entity;
  const summary =
    view && entity ? summarize(view, entity, referenceTime) : null;
  const node = view?.inventory.entities.find(
    (item) => item.uid === entity?.nodeUid
  );
  const relationships =
    view?.inventory.edges
      .filter(
        (edge) => edge.source === entity?.uid || edge.target === entity?.uid
      )
      .filter((edge) => edge.relation !== "contains") ?? [];
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={!!inspected}
    >
      <SheetContent
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[520px]"
        ref={panel}
      >
        <SheetHeader className="border-b pb-4">
          <SheetDescription className="font-mono text-[11px]">
            {entity?.kind} · {entity?.namespace || view?.cluster.name}
          </SheetDescription>
          <SheetTitle className="break-all font-mono text-base">
            {entity?.name ?? "Resource"}
          </SheetTitle>
          {entity && (
            <StatusBadge
              entity={entity}
              stale={
                freshness(view?.inventory.sourceTime, referenceTime) !== "fresh"
              }
            />
          )}
        </SheetHeader>
        {view && entity && summary && (
          <div className="space-y-5 px-4 pb-6">
            <div className="grid grid-cols-3 gap-2 rounded-md border bg-muted/20 p-3">
              <Metric
                icon={Cpu}
                label="CPU used"
                value={compactCpu(summary.cpu)}
              />
              <Metric
                icon={Database}
                label="Memory used"
                value={compactMemory(summary.memory)}
              />
              <Metric
                icon={Server}
                label={entity.kind === "Node" ? "Pods ready" : "Ready"}
                value={
                  summary.ready == null
                    ? "Unknown"
                    : `${summary.ready}/${summary.desired ?? "—"}`
                }
              />
            </div>
            {summary.pods.length > 0 &&
              summary.measured < summary.pods.length &&
              entity.kind !== "Node" && (
                <p className="text-[11px] text-muted-foreground">
                  Pod resource coverage {summary.measured}/{summary.pods.length}
                  . Totals require every member's fresh measurement.
                  {!at && ` ${view.profile.name} collection is active.`}
                </p>
              )}
            <Tabs
              defaultValue="details"
              key={`${view.cluster.id}:${entity.uid}`}
            >
              <TabsList className="w-full">
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="pods">
                  Pods · {summary.pods.length}
                </TabsTrigger>
                <TabsTrigger value="relationships">
                  Links · {relationships.length}
                </TabsTrigger>
              </TabsList>
              <InspectorDetails
                cpu={cpu}
                entity={entity}
                frozen={!!at}
                memory={memory}
                onInspect={onInspect}
                referenceTime={referenceTime}
                summary={summary}
                view={view}
              />
              <TabsContent className="space-y-2 pt-3" value="pods">
                {summary.pods.map((pod) => (
                  <Button
                    className="h-auto w-full justify-between gap-3 border p-3 text-left"
                    key={pod.uid}
                    onClick={() => onInspect(view, pod)}
                    variant="ghost"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[11px]">
                        {pod.name}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        {resourceStatus(pod)} · {readinessLabel(pod)} ·{" "}
                        {pod.restarts ?? 0} restarts
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {compactCpu(
                        observedUsage(view, pod, "cpu", referenceTime)
                      )}
                      <br />
                      {compactMemory(
                        observedUsage(view, pod, "memory", referenceTime)
                      )}
                    </span>
                  </Button>
                ))}
                {!summary.pods.length && (
                  <p className="py-6 text-center text-muted-foreground text-xs">
                    No member pods observed.
                  </p>
                )}
              </TabsContent>
              <TabsContent className="space-y-2 pt-3" value="relationships">
                {relationships.map((edge) => {
                  const other = view.inventory.entities.find(
                    (item) =>
                      item.uid ===
                      (edge.source === entity.uid ? edge.target : edge.source)
                  );
                  return (
                    <div
                      className="rounded-md border p-3"
                      key={`${edge.source}:${edge.target}:${edge.relation}`}
                    >
                      <Badge variant="outline">
                        {edge.relation.replaceAll("_", " ")}
                      </Badge>
                      {other && (
                        <ResourceLink
                          entity={other}
                          label={edge.source === entity.uid ? "To" : "From"}
                          onClick={() => onInspect(view, other)}
                        />
                      )}
                      <p className="mt-2 text-[10px] text-muted-foreground">
                        {edge.evidence}
                      </p>
                    </div>
                  );
                })}
                {!relationships.length && (
                  <p className="py-6 text-center text-muted-foreground text-xs">
                    No configured relationships observed.
                  </p>
                )}
              </TabsContent>
            </Tabs>
            <Button
              className="w-full"
              disabled={!!at}
              onClick={() =>
                onCollection(view, entity.kind === "Node" ? entity : node)
              }
              variant="outline"
            >
              Collection and diagnostic controls
              <ArrowUpRight className="size-3" />
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Cpu;
}) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1 text-[10px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </p>
      <p className="font-mono text-xs">{value}</p>
    </div>
  );
}
function ResourceLink({
  entity,
  label,
  onClick,
}: {
  entity: Entity;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="mt-2">
      <p className="text-[10px] text-muted-foreground">
        {label} · {entity.kind}
      </p>
      <Button
        className="h-auto max-w-full justify-start p-0 font-mono text-xs"
        onClick={onClick}
        variant="link"
      >
        <span className="truncate">{entity.name}</span>
        <ArrowUpRight className="size-3" />
      </Button>
    </div>
  );
}
function formatTime(value: string) {
  return new Date(value).toLocaleString("en", {
    timeZone: "Asia/Riyadh",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function useHistory(
  inspected: { view: ClusterView; entity: Entity } | null,
  field: "cpu" | "memory",
  range: string,
  at: string | undefined,
  referenceTime: number
) {
  return useQuery({
    queryKey: [
      "history",
      inspected?.view.cluster.workspaceId,
      inspected?.view.cluster.id,
      inspected?.entity.uid,
      field,
      range,
      at ?? "live",
    ],
    enabled:
      !!inspected &&
      ["Node", "Pod"].includes(inspected.entity.kind) &&
      referenceTime > 0,
    refetchInterval: at ? false : 30_000,
    queryFn: async () =>
      getHistoryFn({
        data: {
          workspace: inspected?.view.cluster.workspaceId ?? "",
          cluster: inspected?.view.cluster.id ?? "",
          entity: inspected?.entity.uid,
          name: usageName(inspected?.entity, field),
          from: new Date(
            referenceTime - Number(range) * 3_600_000
          ).toISOString(),
          to: at,
        },
      }),
  });
}

function InspectorDetails({
  view,
  entity,
  summary,
  referenceTime,
  onInspect,
  cpu,
  memory,
  frozen,
}: {
  view: ClusterView;
  entity: Entity;
  summary: ResourceSummary;
  referenceTime: number;
  onInspect: (view: ClusterView, entity: Entity) => void;
  cpu: ReturnType<typeof useHistory>;
  memory: ReturnType<typeof useHistory>;
  frozen: boolean;
}) {
  const owner =
    entity.kind === "Pod" ? owningWorkload(view, entity) : undefined;
  const node = view.inventory.entities.find(
    (item) => item.uid === entity.nodeUid
  );
  return (
    <TabsContent className="space-y-5 pt-3" value="details">
      <InspectorMetadata
        entity={entity}
        frozen={frozen}
        referenceTime={referenceTime}
        summary={summary}
        view={view}
      />
      {owner && (
        <ResourceLink
          entity={owner}
          label="Owned by"
          onClick={() => onInspect(view, owner)}
        />
      )}
      {node && (
        <ResourceLink
          entity={node}
          label="Runs on"
          onClick={() => onInspect(view, node)}
        />
      )}
      {entity.conditions?.map((condition) => (
        <p className="rounded-md border p-2 text-xs" key={condition.type}>
          {condition.type}: {condition.status}
          {condition.reason ? ` · ${condition.reason}` : ""}
        </p>
      ))}
      <ContainerResources entity={entity} />
      <InspectorHistory cpu={cpu} entity={entity} memory={memory} />
      <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-[11px] text-muted-foreground">
        <p className="flex items-center gap-1.5">
          <Network className="size-3" />
          Service-call traffic, request latency, and error percentage are
          unavailable.
        </p>
        <p>Inventory sampled {formatTime(view.inventory.sourceTime)}.</p>
        {!frozen && (
          <p>
            Latest cluster receipt{" "}
            {view.cluster.receivedAt
              ? formatTime(view.cluster.receivedAt)
              : "unknown"}
            .
          </p>
        )}
        {frozen && (
          <p>
            Receipt and collection status are not retained for saved
            observations.
          </p>
        )}
        <p className="break-all">Object UID: {entity.uid}</p>
        {entity.providerId && (
          <p className="break-all">Reported provider ID: {entity.providerId}</p>
        )}
      </div>
    </TabsContent>
  );
}

function ContainerResources({ entity }: { entity: Entity }) {
  if (!(entity.containers?.length || entity.resizeConditions?.length)) {
    return null;
  }
  return (
    <div className="space-y-2">
      <h3 className="font-medium text-xs">Applied container resources</h3>
      {entity.containers?.map((container) => (
        <div className="rounded-md border p-3 text-[11px]" key={container.name}>
          <p className="mb-2 font-mono">
            {container.name}
            {container.init ? " · init" : ""}
          </p>
          <p className="text-muted-foreground">
            Applied requests: {compactCpu(container.appliedCpu ?? undefined)}{" "}
            CPU · {compactMemory(container.appliedMemory ?? undefined)} memory
          </p>
          <p className="text-muted-foreground">
            Allocated: {compactCpu(container.allocatedCpu ?? undefined)} CPU ·{" "}
            {compactMemory(container.allocatedMemory ?? undefined)} memory
          </p>
        </div>
      ))}
      {entity.resizeConditions?.map((condition) => (
        <p className="rounded-md border p-2 text-xs" key={condition.type}>
          {condition.type}: {condition.status}
          {condition.reason ? ` · ${condition.reason}` : ""} ·{" "}
          {formatTime(condition.transitionTime)}
        </p>
      ))}
    </div>
  );
}

function InspectorHistory({
  entity,
  cpu,
  memory,
}: {
  entity: Entity;
  cpu: ReturnType<typeof useHistory>;
  memory: ReturnType<typeof useHistory>;
}) {
  return (
    <>
      {" "}
      {entity.kind === "Node" || entity.kind === "Pod" ? (
        <div className="space-y-4">
          {[
            {
              label: "CPU cores used",
              query: cpu,
              field: "cpu" as const,
              unit: "cores",
            },
            {
              label: "Memory working set",
              query: memory,
              field: "memory" as const,
              unit: "GiB",
            },
          ].map((chart) => (
            <div key={chart.field}>
              <h3 className="mb-2 font-medium text-xs">{chart.label}</h3>
              <HistoryPlot
                entity={entity}
                field={chart.field}
                query={chart.query}
                unit={chart.unit}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed p-3 text-[11px] text-muted-foreground">
          Select a member pod to inspect raw resource history. Service and
          workload totals are computed from their observed pods.
        </p>
      )}
    </>
  );
}

function InspectorMetadata({
  view,
  entity,
  summary,
  referenceTime,
  frozen,
}: {
  view: ClusterView;
  entity: Entity;
  summary: ResourceSummary;
  referenceTime: number;
  frozen: boolean;
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
      {metadataRows(view, entity, summary, referenceTime, frozen).map(
        ([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words font-mono text-[11px]">{value}</dd>
          </div>
        )
      )}
    </dl>
  );
}

function metadataRows(
  view: ClusterView,
  entity: Entity,
  summary: ResourceSummary,
  now: number,
  frozen: boolean
) {
  const rows = [
    ["Cluster", view.cluster.name],
    ["Namespace", entity.namespace || "Cluster scope"],
    ["Created", entity.createdAt ? formatTime(entity.createdAt) : "Unknown"],
  ];
  if (["Node", "Pod", "Service"].includes(entity.kind)) {
    rows.push(["Addresses", entity.addresses?.join(", ") || "Unavailable"]);
  }
  if (entity.kind === "Service") {
    rows.push(
      ["Service type", entity.serviceType || "Unknown"],
      [
        "Ports",
        entity.ports
          ?.map((port) => `${port.port}/${port.protocol}`)
          .join(", ") || "Unknown",
      ]
    );
  }
  if (entity.kind === "Ingress") {
    rows.push(["Ingress hosts", entity.hosts?.join(", ") || "Unknown"]);
  }
  if (["Pod", "Deployment", "StatefulSet", "DaemonSet"].includes(entity.kind)) {
    const suffix = entity.kind === "Pod" ? "" : " per pod";
    rows.push(
      [`CPU requested${suffix}`, compactCpu(entity.requestedCpu ?? undefined)],
      [`CPU limited${suffix}`, compactCpu(entity.limitedCpu ?? undefined)],
      [
        `Memory requested${suffix}`,
        compactMemory(entity.requestedMemory ?? undefined),
      ],
      [
        `Memory limited${suffix}`,
        compactMemory(entity.limitedMemory ?? undefined),
      ]
    );
  }
  if (entity.kind === "Node") {
    rows.push(...nodeMetadata(entity));
  }
  rows.push(["Collection", collectionLabel(view, entity, now, frozen)]);
  if (summary.pods.length) {
    rows.push([
      "Restarts observed",
      summary.restarts == null ? "Unknown" : String(summary.restarts),
    ]);
  }
  return rows;
}

function HistoryPlot({
  entity,
  field,
  unit,
  query,
}: {
  entity: Entity;
  field: "cpu" | "memory";
  unit: string;
  query: ReturnType<typeof useHistory>;
}) {
  if (query.isPending) {
    return (
      <Skeleton aria-label="Loading resource history" className="h-36 w-full" />
    );
  }
  if (query.isError) {
    return (
      <p className="rounded-md border p-3 text-xs" role="alert">
        History unavailable.{" "}
        <Button onClick={() => query.refetch()} size="sm" variant="link">
          Retry
        </Button>
      </p>
    );
  }
  return (
    <ResourceChart
      name={usageName(entity, field)}
      samples={query.data ?? []}
      unit={unit}
      valueScale={field === "memory" ? 1 / 1024 ** 3 : 1}
    />
  );
}

function nodeMetadata(entity: Entity) {
  return [
    [
      "CPU capacity / allocatable",
      `${compactCpu(entity.capacityCpu ?? undefined)} / ${compactCpu(entity.allocatableCpu ?? undefined)}`,
    ],
    [
      "Memory capacity / allocatable",
      `${compactMemory(entity.capacityMemory ?? undefined)} / ${compactMemory(entity.allocatableMemory ?? undefined)}`,
    ],
    ["OS / kernel", entity.os ? `${entity.os} · ${entity.kernel}` : "Unknown"],
    ["Kubelet", entity.kubeletVersion || "Unknown"],
    [
      "Region / zone",
      [entity.region, entity.zone].filter(Boolean).join(" / ") ||
        "Not reported",
    ],
  ];
}

function collectionLabel(
  view: ClusterView,
  entity: Entity,
  now: number,
  frozen: boolean
) {
  if (frozen) {
    return "Not retained historically";
  }
  return entity.kind === "Node"
    ? nodeProfileOutcome(view, entity.uid, now)
    : `${view.profile.name} profile`;
}
