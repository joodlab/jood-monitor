import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  ArrowUpRight,
  Box,
  Clock,
  GitBranch,
  Globe,
  Network,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatUsage, type UsageField } from "../lib/chart-scale";
import { collectionState } from "../lib/collection-state";
import {
  owningWorkload,
  type ResourceSummary,
  workloadKinds,
} from "../lib/infrastructure";
import { nodeProfileOutcome } from "../lib/metrics";
import { CopyButton } from "./inspector-copy";
import { exposure, ingressesFor, placement } from "./inspector-model";
import {
  ConditionList,
  ExposedBy,
  IngressRoutes,
  InspectorSection,
  Placement,
  ResourceLink,
} from "./inspector-sections";
import { TimeText } from "./time";

type Inspect = (view: ClusterView, entity: Entity) => void;

// Railway's Settings tab, read-only: conditions, ownership, configured
// exposure and placement, configuration, observation times and the
// collection controls, each as a section on the rail.
export function DetailsTab({
  view,
  entity,
  summary,
  referenceTime,
  frozen,
  onInspect,
  onCollection,
}: {
  view: ClusterView;
  entity: Entity;
  summary: ResourceSummary;
  referenceTime: number;
  frozen: boolean;
  onInspect: Inspect;
  onCollection: (view: ClusterView, node?: Entity) => void;
}) {
  const node = view.inventory.entities.find(
    (item) => item.uid === entity.nodeUid
  );
  return (
    <div>
      <ConditionList conditions={entity.conditions} />
      <Ownership entity={entity} onInspect={onInspect} view={view} />
      <Configured
        entity={entity}
        onInspect={onInspect}
        summary={summary}
        view={view}
      />
      <InspectorMetadata
        entity={entity}
        frozen={frozen}
        referenceTime={referenceTime}
        summary={summary}
        view={view}
      />
      <ContainerResources entity={entity} />
      <ObservationFooter entity={entity} frozen={frozen} view={view} />
      <InspectorSection
        description={
          frozen
            ? "Unavailable for a saved observation; collection status is not retained historically."
            : "Profiles, per-node acknowledgments and time-boxed diagnostics for this cluster."
        }
        icon={Settings2}
        title="Collection"
      >
        <Button
          className="w-fit focus-visible:ring-2 focus-visible:ring-ring"
          disabled={frozen}
          onClick={() =>
            onCollection(view, entity.kind === "Node" ? entity : node)
          }
          variant="outline"
        >
          Collection and diagnostic controls
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Button>
      </InspectorSection>
    </div>
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
    <InspectorSection icon={GitBranch} title="Ownership">
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
    </InspectorSection>
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
          icon={Globe}
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
    <InspectorSection icon={SlidersHorizontal} title="Configuration">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border bg-background/40 p-4 text-sm sm:grid-cols-2">
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
  if (entity.kind === "Node") {
    return nodeProfileOutcome(view, entity.uid, now);
  }
  const state = collectionState(view, now);
  return `${state.label} profile${state.paused ? " · paused" : ""}`;
}

function ContainerResources({ entity }: { entity: Entity }) {
  if (!(entity.containers?.length || entity.resizeConditions?.length)) {
    return null;
  }
  return (
    <InspectorSection icon={Box} title="Applied container resources">
      <ul className="space-y-2">
        {entity.containers?.map((container) => (
          <li
            className="rounded-lg border bg-background/40 p-3 text-xs"
            key={container.name}
          >
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
        <p className="rounded-lg border p-2 text-xs" key={condition.type}>
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
    <InspectorSection
      description="Source time is the observer's clock; receipt time is the hub's."
      icon={Clock}
      title="Observation"
    >
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
