import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Sheet, SheetContent } from "@jood-monitor/ui/sheet";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Cpu, Database, Network, Server } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { getHistoryFn } from "../functions/clusters";
import {
  formatUsage,
  percentOf,
  type Reference,
  references,
  type UsageField,
} from "../lib/chart-scale";
import {
  owningWorkload,
  type ResourceSummary,
  summarize,
  workloadKinds,
} from "../lib/infrastructure";
import { nodeProfileOutcome, usageName } from "../lib/metrics";
import { CopyButton } from "./inspector-copy";
import { InspectorHeader, useInspectionTrail } from "./inspector-header";
import {
  type Coverage,
  type Crumb,
  exposure,
  historyRefetchInterval,
  ingressesFor,
  inspectionKey,
  placement,
  podCoverage,
  relationships,
} from "./inspector-model";
import {
  ConditionList,
  CoverageNote,
  ExposedBy,
  IngressRoutes,
  InspectorSection,
  Placement,
  PodList,
  RelationshipList,
  ResourceLink,
} from "./inspector-sections";
import { ResourceChart } from "./resource-chart";
import { TimeText } from "./time";

type Inspect = (view: ClusterView, entity: Entity) => void;
type Inspected = { view: ClusterView; entity: Entity } | null;

export function ResourceInspector({
  inspected,
  onClose,
  onInspect,
  referenceTime,
  range,
  at,
  connection,
  scope,
  onCollection,
}: {
  inspected: Inspected;
  onClose: () => void;
  onInspect: Inspect;
  referenceTime: number;
  range: string;
  at?: string;
  // The dashboard's monitoring stream state; slows history polling while
  // stream notifications are arriving.
  connection?: string;
  // The dashboard scope (a workspace id or "global"), so stream
  // notifications for that scope refresh the history; defaults to the
  // resource's own workspace.
  scope?: string;
  onCollection: (view: ClusterView, node?: Entity) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const key = inspected ? inspectionKey(inspected.view, inspected.entity) : "";
  useEffect(() => {
    if (key) {
      panel.current?.scrollTo({ top: 0 });
    }
  }, [key]);
  const trail = useInspectionTrail(inspected);
  const live = { at, connection, scope, range, referenceTime };
  const cpu = useHistory(inspected, "cpu", live);
  const memory = useHistory(inspected, "memory", live);
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
        className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
        ref={panel}
        showCloseButton={false}
      >
        {inspected && (
          <InspectorBody
            cpu={cpu}
            entity={inspected.entity}
            frozen={!!at}
            memory={memory}
            onCollection={onCollection}
            onInspect={onInspect}
            referenceTime={referenceTime}
            trail={trail}
            view={inspected.view}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

interface HistoryWindow {
  at?: string;
  connection?: string;
  range: string;
  referenceTime: number;
  scope?: string;
}

function useHistory(
  inspected: Inspected,
  field: UsageField,
  { at, connection, scope, range, referenceTime }: HistoryWindow
) {
  const workspace = inspected?.view.cluster.workspaceId;
  return useQuery({
    // The scope leads the key so the stream's per-scope invalidation
    // reaches it, including the all-workspaces view.
    queryKey: [
      "history",
      scope ?? workspace,
      workspace,
      inspected?.view.cluster.id,
      inspected?.entity.uid,
      field,
      range,
      at ?? "live",
      "window",
    ],
    enabled:
      !!inspected &&
      ["Node", "Pod"].includes(inspected.entity.kind) &&
      referenceTime > 0,
    refetchInterval: historyRefetchInterval(at, connection),
    queryFn: async () => {
      // The chart's time axis is exactly the queried window.
      const to = at ? Date.parse(at) : Date.now();
      const from = to - Number(range) * 3_600_000;
      const samples = await getHistoryFn({
        data: {
          workspace: workspace ?? "",
          cluster: inspected?.view.cluster.id ?? "",
          entity: inspected?.entity.uid,
          name: usageName(inspected?.entity, field),
          from: new Date(from).toISOString(),
          to: at,
        },
      });
      return { samples, from, to };
    },
  });
}
type HistoryQuery = ReturnType<typeof useHistory>;

function InspectorBody({
  view,
  entity,
  trail,
  referenceTime,
  frozen,
  cpu,
  memory,
  onInspect,
  onCollection,
}: {
  view: ClusterView;
  entity: Entity;
  trail: readonly Crumb[];
  referenceTime: number;
  frozen: boolean;
  cpu: HistoryQuery;
  memory: HistoryQuery;
  onInspect: Inspect;
  onCollection: (view: ClusterView, node?: Entity) => void;
}) {
  const summary = summarize(view, entity, referenceTime);
  const coverage = podCoverage(summary);
  const links = relationships(view, entity);
  // The selected tab survives moving between resources of the same kind.
  const [selection, setSelection] = useState({
    kind: entity.kind,
    tab: "details",
  });
  const tab = selection.kind === entity.kind ? selection.tab : "details";
  const select = (value: string) =>
    setSelection({ kind: entity.kind, tab: value });
  const showPods = entity.kind !== "Pod";
  const node = view.inventory.entities.find(
    (item) => item.uid === entity.nodeUid
  );
  return (
    <>
      <InspectorHeader
        entity={entity}
        onInspect={onInspect}
        referenceTime={referenceTime}
        trail={trail}
        view={view}
      />
      <div className="space-y-5 px-4 pt-4 pb-6">
        <UsageMetrics coverage={coverage} entity={entity} summary={summary} />
        {entity.kind !== "Node" && entity.kind !== "Pod" && (
          <CoverageNote
            coverage={coverage}
            profile={frozen ? undefined : view.profile.name}
          />
        )}
        <Tabs onValueChange={(value) => select(String(value))} value={tab}>
          <TabsList className="w-full">
            <TabsTrigger value="details">Details</TabsTrigger>
            {showPods && (
              <TabsTrigger value="pods">
                Pods · {summary.pods.length}
              </TabsTrigger>
            )}
            <TabsTrigger value="relationships">
              Links · {links.length}
            </TabsTrigger>
          </TabsList>
          <TabsContent className="space-y-6 pt-3" value="details">
            <InspectorDetails
              cpu={cpu}
              entity={entity}
              frozen={frozen}
              memory={memory}
              onInspect={onInspect}
              onShowPods={() => select("pods")}
              referenceTime={referenceTime}
              summary={summary}
              view={view}
            />
          </TabsContent>
          {showPods && (
            <TabsContent className="pt-3" value="pods">
              <PodList
                now={referenceTime}
                onInspect={onInspect}
                pods={summary.pods}
                view={view}
              />
            </TabsContent>
          )}
          <TabsContent className="pt-3" value="relationships">
            <RelationshipList
              entity={entity}
              links={links}
              onInspect={onInspect}
              view={view}
            />
          </TabsContent>
        </Tabs>
        <div className="space-y-1.5">
          <Button
            className="w-full"
            disabled={frozen}
            onClick={() =>
              onCollection(view, entity.kind === "Node" ? entity : node)
            }
            variant="outline"
          >
            Collection and diagnostic controls
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Button>
          {frozen && (
            <p className="text-center text-muted-foreground text-xs">
              Unavailable for a saved observation; collection status is not
              retained historically.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// A complete total, an explicitly partial lower bound, or the reason there
// is no value. A missing measurement never reads as zero.
function usageValue(
  field: UsageField,
  entity: Entity,
  summary: ResourceSummary,
  coverage: Coverage
) {
  const value = summary[field];
  if (value != null) {
    return {
      value: formatUsage(field, value),
      detail: usageShare(field, value, entity),
    };
  }
  if (entity.kind === "Pod" || entity.kind === "Node") {
    return { value: "No fresh sample" };
  }
  if (!coverage.active) {
    return { value: "No active pods" };
  }
  const partial = summary.usage?.[field];
  if (partial?.observed == null) {
    return { value: "No fresh samples" };
  }
  return {
    value: `≥ ${formatUsage(field, partial.observed)}`,
    detail: `partial · ${partial.measured} of ${coverage.active} pods`,
  };
}

function usageShare(field: UsageField, value: number, entity: Entity) {
  if (entity.kind === "Pod") {
    const limit = field === "cpu" ? entity.limitedCpu : entity.limitedMemory;
    const share = percentOf(value, limit ?? undefined);
    return share && `${share} of limit`;
  }
  if (entity.kind === "Node") {
    const allocatable =
      field === "cpu" ? entity.allocatableCpu : entity.allocatableMemory;
    const share = percentOf(value, allocatable ?? undefined);
    return share && `${share} of allocatable`;
  }
}

function readyText(summary: ResourceSummary) {
  if (summary.ready == null) {
    return "Unknown";
  }
  return summary.desired == null
    ? `${summary.ready} ready`
    : `${summary.ready}/${summary.desired}`;
}

function UsageMetrics({
  entity,
  summary,
  coverage,
}: {
  entity: Entity;
  summary: ResourceSummary;
  coverage: Coverage;
}) {
  const total = entity.kind !== "Pod" && entity.kind !== "Node";
  const cpu = usageValue("cpu", entity, summary, coverage);
  const memory = usageValue("memory", entity, summary, coverage);
  return (
    <dl className="grid grid-cols-3 gap-3 rounded-md border bg-muted/20 p-3">
      <Metric
        detail={cpu.detail}
        icon={Cpu}
        label={total ? "CPU used (sum)" : "CPU used"}
        value={cpu.value}
      />
      <Metric
        detail={memory.detail}
        icon={Database}
        label={total ? "Memory (sum)" : "Memory used"}
        value={memory.value}
      />
      <Metric
        icon={Server}
        label={entity.kind === "Node" ? "Pods ready" : "Ready"}
        value={readyText(summary)}
      />
    </dl>
  );
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: typeof Cpu;
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 flex items-center gap-1 text-muted-foreground text-xs">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </dt>
      <dd className="font-medium text-sm tabular-nums">{value}</dd>
      {detail && (
        <dd className="text-muted-foreground text-xs tabular-nums">{detail}</dd>
      )}
    </div>
  );
}

function InspectorDetails({
  view,
  entity,
  summary,
  referenceTime,
  onInspect,
  onShowPods,
  cpu,
  memory,
  frozen,
}: {
  view: ClusterView;
  entity: Entity;
  summary: ResourceSummary;
  referenceTime: number;
  onInspect: Inspect;
  onShowPods: () => void;
  cpu: HistoryQuery;
  memory: HistoryQuery;
  frozen: boolean;
}) {
  const measured = entity.kind === "Node" || entity.kind === "Pod";
  return (
    <>
      <ConditionList conditions={entity.conditions} />
      <Ownership entity={entity} onInspect={onInspect} view={view} />
      <Configured
        entity={entity}
        onInspect={onInspect}
        summary={summary}
        view={view}
      />
      {measured ? (
        <InspectorHistory cpu={cpu} entity={entity} memory={memory} />
      ) : (
        <MemberHistoryHint onShowPods={onShowPods} pods={summary.pods.length} />
      )}
      <InspectorMetadata
        entity={entity}
        frozen={frozen}
        referenceTime={referenceTime}
        summary={summary}
        view={view}
      />
      <ContainerResources entity={entity} />
      <ObservationFooter entity={entity} frozen={frozen} view={view} />
    </>
  );
}

function Ownership({
  view,
  entity,
  onInspect,
}: {
  view: ClusterView;
  entity: Entity;
  onInspect: Inspect;
}) {
  const owner =
    entity.kind === "Pod" ? owningWorkload(view, entity) : undefined;
  const node =
    entity.kind === "Pod"
      ? view.inventory.entities.find((item) => item.uid === entity.nodeUid)
      : undefined;
  if (!(owner || node)) {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-3">
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
    </div>
  );
}

// Configured exposure and placement for workloads and Services.
function Configured({
  view,
  entity,
  summary,
  onInspect,
}: {
  view: ClusterView;
  entity: Entity;
  summary: ResourceSummary;
  onInspect: Inspect;
}) {
  const workload = workloadKinds.has(entity.kind);
  if (!(workload || entity.kind === "Service")) {
    return null;
  }
  const placed = placement(view, summary.pods);
  const routes = entity.kind === "Service" ? ingressesFor(view, entity) : [];
  return (
    <>
      {workload && (
        <ExposedBy
          exposures={exposure(view, summary.services)}
          onInspect={onInspect}
          view={view}
        />
      )}
      {entity.kind === "Service" && (
        <InspectorSection
          description="Configured routing, not measured traffic."
          title="Routed from"
        >
          {routes.length ? (
            <IngressRoutes
              ingresses={routes}
              onInspect={onInspect}
              view={view}
            />
          ) : (
            <p className="text-muted-foreground text-xs">
              No Ingress is configured to route to this Service.
            </p>
          )}
        </InspectorSection>
      )}
      {(placed.nodes.length > 0 || placed.unscheduled > 0) && (
        <Placement
          nodes={placed.nodes}
          onInspect={onInspect}
          unscheduled={placed.unscheduled}
          view={view}
        />
      )}
    </>
  );
}

function MemberHistoryHint({
  pods,
  onShowPods,
}: {
  pods: number;
  onShowPods: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3">
      <p className="min-w-0 flex-1 text-muted-foreground text-xs">
        Raw resource history is kept per Pod and Node. Totals here are summed
        from observed member pods.
      </p>
      {pods > 0 && (
        <Button onClick={onShowPods} size="sm" variant="outline">
          Member pods
        </Button>
      )}
    </div>
  );
}

function ContainerResources({ entity }: { entity: Entity }) {
  if (!(entity.containers?.length || entity.resizeConditions?.length)) {
    return null;
  }
  return (
    <InspectorSection title="Applied container resources">
      <ul className="space-y-2">
        {entity.containers?.map((container) => (
          <li className="rounded-md border p-3 text-xs" key={container.name}>
            <p className="mb-1 font-mono">
              {container.name}
              {container.init ? (
                <span className="font-sans text-muted-foreground"> · init</span>
              ) : null}
            </p>
            <p className="text-muted-foreground tabular-nums">
              Applied requests: {configured("cpu", container.appliedCpu)} CPU ·{" "}
              {configured("memory", container.appliedMemory)} memory
            </p>
            <p className="text-muted-foreground tabular-nums">
              Allocated: {configured("cpu", container.allocatedCpu)} CPU ·{" "}
              {configured("memory", container.allocatedMemory)} memory
            </p>
          </li>
        ))}
      </ul>
      {entity.resizeConditions?.map((condition) => (
        <p className="rounded-md border p-2 text-xs" key={condition.type}>
          {condition.type}: {condition.status}
          {condition.reason ? ` · ${condition.reason}` : ""} ·{" "}
          <TimeText
            label="Resize condition transition"
            value={condition.transitionTime}
          />
        </p>
      ))}
    </InspectorSection>
  );
}

const charts: { field: UsageField; title: string }[] = [
  { field: "cpu", title: "CPU used" },
  { field: "memory", title: "Memory working set" },
];

function InspectorHistory({
  entity,
  cpu,
  memory,
}: {
  entity: Entity;
  cpu: HistoryQuery;
  memory: HistoryQuery;
}) {
  return (
    <div className="space-y-6">
      {charts.map((chart) => (
        <HistoryPlot
          entity={entity}
          field={chart.field}
          key={chart.field}
          query={chart.field === "cpu" ? cpu : memory}
          title={chart.title}
        />
      ))}
    </div>
  );
}

// Requests and limits for Pods, allocatable for Nodes, as dashed references.
function chartReferences(entity: Entity, field: UsageField) {
  const cpu = field === "cpu";
  if (entity.kind === "Node") {
    const refs = references([
      {
        label: "allocatable",
        dash: "6 3",
        value: cpu ? entity.allocatableCpu : entity.allocatableMemory,
      },
    ]);
    return { refs, percentBase: refs[0] as Reference | undefined };
  }
  const refs = references([
    {
      label: "request",
      dash: "2 3",
      value: cpu ? entity.requestedCpu : entity.requestedMemory,
    },
    {
      label: "limit",
      dash: "6 3",
      value: cpu ? entity.limitedCpu : entity.limitedMemory,
    },
  ]);
  return { refs, percentBase: refs.find((ref) => ref.label === "limit") };
}

function HistoryPlot({
  entity,
  field,
  title,
  query,
}: {
  entity: Entity;
  field: UsageField;
  title: string;
  query: HistoryQuery;
}) {
  const { refs, percentBase } = useMemo(
    () => chartReferences(entity, field),
    [entity, field]
  );
  if (query.isPending) {
    return (
      <div className="space-y-2">
        <h3 className="font-medium text-sm">{title}</h3>
        <Skeleton
          aria-label={`Loading ${title} history`}
          className="h-[200px] w-full"
        />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-2">
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="rounded-md border p-3 text-sm" role="alert">
          History unavailable.{" "}
          <Button onClick={() => query.refetch()} size="sm" variant="link">
            Retry
          </Button>
        </p>
      </div>
    );
  }
  return (
    <ResourceChart
      field={field}
      from={query.data.from}
      name={usageName(entity, field)}
      percentBase={percentBase}
      references={refs}
      samples={query.data.samples}
      subject={`${entity.kind} ${entity.name}`}
      title={title}
      to={query.data.to}
    />
  );
}

interface MetaRow {
  copy?: string;
  label: string;
  mono?: boolean;
  value: ReactNode;
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
    <InspectorSection title="Configuration">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        {metadataRows(view, entity, summary, referenceTime, frozen).map(
          (row) => (
            <div className="min-w-0" key={row.label}>
              <dt className="text-muted-foreground text-xs">{row.label}</dt>
              <dd className="mt-0.5 flex items-start gap-1">
                <span
                  className={`min-w-0 break-words ${row.mono ? "font-mono text-xs" : "text-sm"}`}
                >
                  {row.value}
                </span>
                {row.copy && (
                  <CopyButton
                    className="-my-1.5 shrink-0"
                    label={`Copy ${row.label.toLowerCase()}`}
                    value={row.copy}
                  />
                )}
              </dd>
            </div>
          )
        )}
      </dl>
    </InspectorSection>
  );
}

function metadataRows(
  view: ClusterView,
  entity: Entity,
  summary: ResourceSummary,
  now: number,
  frozen: boolean
): MetaRow[] {
  const rows: MetaRow[] = [
    { label: "Cluster", value: view.cluster.name },
    {
      label: "Namespace",
      value: entity.namespace || "Cluster scope",
      mono: !!entity.namespace,
    },
    {
      label: "Created",
      value: <TimeText label="Created" value={entity.createdAt} />,
    },
    ...networkRows(entity),
    ...resourceRows(entity),
  ];
  if (entity.kind === "Node") {
    rows.push(...nodeRows(entity));
  }
  rows.push({
    label: "Collection",
    value: collectionLabel(view, entity, now, frozen),
  });
  if (summary.pods.length) {
    rows.push({
      label: "Restarts observed",
      value: summary.restarts == null ? "Unknown" : String(summary.restarts),
    });
  }
  return rows;
}

function networkRows(entity: Entity): MetaRow[] {
  const rows: MetaRow[] = [];
  if (["Node", "Pod", "Service"].includes(entity.kind)) {
    const addresses = entity.addresses?.join(", ");
    rows.push({
      label: "Addresses",
      value: addresses || "Not reported",
      mono: !!addresses,
      copy: addresses || undefined,
    });
  }
  if (entity.kind === "Service") {
    rows.push(
      { label: "Service type", value: entity.serviceType || "Unknown" },
      {
        label: "Ports",
        value:
          entity.ports
            ?.map((port) => `${port.port}/${port.protocol}`)
            .join(", ") || "Unknown",
        mono: !!entity.ports?.length,
      }
    );
  }
  if (entity.kind === "Ingress") {
    const hosts = entity.hosts?.join(", ");
    rows.push({
      label: "Ingress hosts",
      value: hosts || "No host rules",
      mono: !!hosts,
      copy: hosts || undefined,
    });
  }
  return rows;
}

function configured(field: UsageField, value?: number | null) {
  return value == null ? "None reported" : formatUsage(field, value);
}

function resourceRows(entity: Entity): MetaRow[] {
  if (
    !["Pod", "Deployment", "StatefulSet", "DaemonSet"].includes(entity.kind)
  ) {
    return [];
  }
  const suffix = entity.kind === "Pod" ? "" : " per pod";
  return [
    {
      label: `CPU request${suffix}`,
      value: configured("cpu", entity.requestedCpu),
    },
    {
      label: `CPU limit${suffix}`,
      value: configured("cpu", entity.limitedCpu),
    },
    {
      label: `Memory request${suffix}`,
      value: configured("memory", entity.requestedMemory),
    },
    {
      label: `Memory limit${suffix}`,
      value: configured("memory", entity.limitedMemory),
    },
  ];
}

function nodeRows(entity: Entity): MetaRow[] {
  return [
    {
      label: "CPU capacity / allocatable",
      value: `${configured("cpu", entity.capacityCpu)} / ${configured("cpu", entity.allocatableCpu)}`,
    },
    {
      label: "Memory capacity / allocatable",
      value: `${configured("memory", entity.capacityMemory)} / ${configured("memory", entity.allocatableMemory)}`,
    },
    {
      label: "OS / kernel",
      value: entity.os ? `${entity.os} · ${entity.kernel}` : "Unknown",
    },
    { label: "Kubelet", value: entity.kubeletVersion || "Unknown" },
    {
      label: "Region / zone",
      value:
        [entity.region, entity.zone].filter(Boolean).join(" / ") ||
        "Not reported",
    },
    ...(entity.roles?.length
      ? [{ label: "Roles", value: entity.roles.join(", ") }]
      : []),
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

function ObservationFooter({
  view,
  entity,
  frozen,
}: {
  view: ClusterView;
  entity: Entity;
  frozen: boolean;
}) {
  return (
    <InspectorSection title="Observation">
      <ul className="space-y-1 text-muted-foreground text-xs">
        <li>
          Inventory source time{" "}
          <TimeText
            absolute={frozen}
            className="text-foreground"
            label="Inventory source time"
            value={view.inventory.sourceTime}
          />
        </li>
        {frozen ? (
          <li>
            Hub receipts and collection status are not retained historically for
            saved observations.
          </li>
        ) : (
          <li>
            Latest hub receipt{" "}
            <TimeText
              className="text-foreground"
              label="Hub receipt time"
              value={view.cluster.receivedAt}
            />
          </li>
        )}
        <li className="flex items-start gap-1.5">
          <Network aria-hidden className="mt-px size-3.5 shrink-0" />
          Service-call traffic, request latency and error rates are not
          collected.
        </li>
      </ul>
      <dl className="space-y-1 text-xs">
        <Identity label="Object UID" value={entity.uid} />
        {entity.providerId && (
          <Identity label="Provider ID" value={entity.providerId} />
        )}
      </dl>
    </InspectorSection>
  );
}

function Identity({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1">
        <span className="min-w-0 flex-1 break-all font-mono">{value}</span>
        <CopyButton
          className="shrink-0"
          label={`Copy ${label.toLowerCase()}`}
          value={value}
        />
      </dd>
    </div>
  );
}
