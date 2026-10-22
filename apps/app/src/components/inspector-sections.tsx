import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import {
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Info,
  Server,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { podProblem } from "../lib/attention";
import { formatUsage } from "../lib/chart-scale";
import {
  isFinished,
  podReady,
  readinessLabel,
  resourceStatus,
} from "../lib/infrastructure";
import { observedUsage } from "../lib/metrics";
import {
  type Coverage,
  conditionGroups,
  type Exposure,
  type NodePlacement,
  type Relationship,
  relationText,
  sortPods,
  splitRevisions,
} from "./inspector-model";
import { TimeText } from "./time";

type Inspect = (view: ClusterView, entity: Entity) => void;
type Condition = NonNullable<Entity["conditions"]>[number];

export function InspectorSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        {description && (
          <p className="text-muted-foreground text-xs">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Disclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        aria-expanded={open}
        className="h-8 px-2 text-muted-foreground text-xs"
        onClick={() => setOpen((value) => !value)}
        size="sm"
        variant="ghost"
      >
        <ChevronDown
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
        {label}
      </Button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

export function ResourceLink({
  entity,
  label,
  onClick,
}: {
  entity: Entity;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-xs">
        {label} · {entity.kind}
      </p>
      <Button
        className="h-8 max-w-full justify-start px-0 font-mono text-xs"
        onClick={onClick}
        variant="link"
      >
        <span className="truncate">{entity.name}</span>
        <ArrowUpRight aria-hidden className="size-3" />
      </Button>
    </div>
  );
}

function ConditionRow({
  condition,
  abnormal,
}: {
  condition: Condition;
  abnormal: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-2 text-xs",
        abnormal ? "text-warning-text" : "text-muted-foreground"
      )}
    >
      {abnormal ? (
        <TriangleAlert
          aria-label="Abnormal"
          className="mt-px size-3.5 shrink-0"
        />
      ) : (
        <span
          aria-hidden
          className="mt-1 size-2 shrink-0 rounded-full bg-muted-foreground/50"
        />
      )}
      <span className="min-w-0">
        <span className={cn("font-medium", abnormal && "text-foreground")}>
          {condition.type}
        </span>{" "}
        {condition.status}
        {condition.reason ? ` · ${condition.reason}` : ""}
      </span>
    </li>
  );
}

// Abnormal conditions first; an all-normal set collapses to one line.
export function ConditionList({
  conditions,
}: {
  conditions?: readonly Condition[];
}) {
  if (!conditions?.length) {
    return null;
  }
  const { abnormal, normal } = conditionGroups(conditions);
  const normalRows = (
    <ul className="space-y-1">
      {normal.map((condition) => (
        <ConditionRow
          abnormal={false}
          condition={condition}
          key={condition.type}
        />
      ))}
    </ul>
  );
  return (
    <InspectorSection title="Conditions">
      {abnormal.length > 0 ? (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
          <ul className="space-y-1">
            {abnormal.map((condition) => (
              <ConditionRow
                abnormal
                condition={condition}
                key={condition.type}
              />
            ))}
          </ul>
          {normalRows}
        </div>
      ) : (
        <div className="-mx-2 flex flex-col">
          <Disclosure
            label={
              normal.length === 1
                ? `${normal[0].type} condition normal`
                : `All ${normal.length} conditions normal`
            }
          >
            <div className="px-2">{normalRows}</div>
          </Disclosure>
        </div>
      )}
    </InspectorSection>
  );
}

// Explains partial totals with counts. Finished pods never count against it.
export function CoverageNote({
  coverage,
  profile,
}: {
  coverage: Coverage;
  // Active collection profile; omitted for saved observations.
  profile?: string;
}) {
  const { active, measured, finished } = coverage;
  if (!active || measured >= active) {
    return finished ? (
      <p className="text-muted-foreground text-xs">
        {finished} finished pod{finished === 1 ? " is" : "s are"} excluded;
        finished pods are not expected to report usage.
      </p>
    ) : null;
  }
  const missing = active - measured;
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-info/30 bg-info/5 p-2 text-xs">
      <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info-text" />
      <span>
        Partial coverage: {measured} of {active} active pods have a fresh CPU
        and memory sample; {missing} {missing === 1 ? "has" : "have"} none, so
        totals are not summed.
        {finished > 0 &&
          ` ${finished} finished pod${finished === 1 ? " is" : "s are"} excluded.`}
        {profile && ` Collection profile: ${profile}.`}
      </span>
    </p>
  );
}

function PodStateIcon({ pod, now }: { pod: Entity; now: number }) {
  if (isFinished(pod)) {
    return (
      <CircleDashed
        aria-label="Finished"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
    );
  }
  if (podProblem(pod, now)) {
    return (
      <TriangleAlert
        aria-label="Needs attention"
        className="mt-0.5 size-4 shrink-0 text-warning-text"
      />
    );
  }
  if (podReady(pod) == null) {
    return (
      <CircleHelp
        aria-label="Readiness unknown"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
    );
  }
  return (
    <CircleCheck
      aria-label="Ready"
      className="mt-0.5 size-4 shrink-0 text-success-text"
    />
  );
}

function podUsage(view: ClusterView, pod: Entity, now: number) {
  if (isFinished(pod)) {
    return { cpu: "finished", memory: "not reporting" };
  }
  return {
    cpu: formatUsage("cpu", observedUsage(view, pod, "cpu", now)),
    memory: formatUsage("memory", observedUsage(view, pod, "memory", now)),
  };
}

export function PodList({
  view,
  pods,
  now,
  onInspect,
}: {
  view: ClusterView;
  pods: readonly Entity[];
  now: number;
  onInspect: Inspect;
}) {
  if (!pods.length) {
    return (
      <p className="py-6 text-center text-muted-foreground text-sm">
        No member pods observed.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border">
      {sortPods(pods, now).map((pod) => {
        const node = view.inventory.entities.find(
          (item) => item.uid === pod.nodeUid
        );
        const usage = podUsage(view, pod, now);
        return (
          <li key={pod.uid}>
            <button
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
              onClick={() => onInspect(view, pod)}
              type="button"
            >
              <PodStateIcon now={now} pod={pod} />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block truncate font-mono text-xs">
                  {pod.name}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {resourceStatus(pod)} · {readinessLabel(pod)} ·{" "}
                  {pod.restarts ?? 0} restart{pod.restarts === 1 ? "" : "s"}
                </span>
                <span className="flex flex-wrap gap-x-1.5 text-muted-foreground text-xs">
                  <span className="max-w-full truncate">
                    on{" "}
                    <span className="font-mono">
                      {node?.name ??
                        (pod.nodeUid ? "unlisted node" : "no node")}
                    </span>
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    created <TimeText label="Created" value={pod.createdAt} />
                  </span>
                </span>
              </span>
              <span className="shrink-0 text-right text-xs tabular-nums">
                <span className="block">{usage.cpu}</span>
                <span className="block text-muted-foreground">
                  {usage.memory}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RelationshipItem({
  link,
  entity,
  view,
  onInspect,
}: {
  link: Relationship;
  entity: Entity;
  view: ClusterView;
  onInspect: Inspect;
}) {
  const other = link.other;
  return (
    <li className="space-y-1 rounded-md border p-3">
      <p className="text-muted-foreground text-xs">
        {relationText(link, entity)}
      </p>
      {other ? (
        <Button
          className="h-8 max-w-full justify-start px-0 font-mono text-xs"
          onClick={() => onInspect(view, other)}
          variant="link"
        >
          <span className="truncate">{other.name}</span>
          <ArrowUpRight aria-hidden className="size-3" />
        </Button>
      ) : (
        <p className="text-xs">
          Not in this observation ·{" "}
          <span className="font-mono">
            {link.outgoing ? link.edge.target : link.edge.source}
          </span>
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        Evidence: {link.edge.evidence}
      </p>
    </li>
  );
}

export function RelationshipList({
  links,
  entity,
  view,
  onInspect,
}: {
  links: readonly Relationship[];
  entity: Entity;
  view: ClusterView;
  onInspect: Inspect;
}) {
  if (!links.length) {
    return (
      <p className="py-6 text-center text-muted-foreground text-sm">
        No configured relationships observed.
      </p>
    );
  }
  const { current, previous } = splitRevisions(links);
  const item = (link: Relationship) => (
    <RelationshipItem
      entity={entity}
      key={`${link.edge.source}:${link.edge.target}:${link.edge.relation}`}
      link={link}
      onInspect={onInspect}
      view={view}
    />
  );
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Configured and discovered structure, not measured traffic.
      </p>
      <ul className="space-y-2">{current.map(item)}</ul>
      {previous.length > 0 && (
        <div className="-mx-2">
          <Disclosure label={`Previous revisions (${previous.length})`}>
            <ul className="space-y-2 px-2">{previous.map(item)}</ul>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

function ports(service: Entity) {
  return (
    service.ports
      ?.map(
        (port) =>
          `${port.port}/${port.protocol}${port.name ? ` (${port.name})` : ""}`
      )
      .join(", ") || "ports unknown"
  );
}

export function ExposedBy({
  view,
  exposures,
  onInspect,
}: {
  view: ClusterView;
  exposures: readonly Exposure[];
  onInspect: Inspect;
}) {
  return (
    <InspectorSection
      description="Configured routing, not measured traffic."
      title="Exposed by"
    >
      {exposures.length ? (
        <ul className="space-y-2">
          {exposures.map(({ service, ingresses }) => (
            <li className="rounded-md border p-3" key={service.uid}>
              <div className="flex flex-wrap items-center justify-between gap-x-3">
                <Button
                  className="h-8 max-w-full justify-start px-0 font-mono text-xs"
                  onClick={() => onInspect(view, service)}
                  variant="link"
                >
                  <span className="truncate">Service {service.name}</span>
                  <ArrowUpRight aria-hidden className="size-3" />
                </Button>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {service.serviceType || "type unknown"} · {ports(service)}
                </span>
              </div>
              {ingresses.length > 0 && (
                <IngressRoutes
                  ingresses={ingresses}
                  onInspect={onInspect}
                  view={view}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">
          No Service is configured to select these pods.
        </p>
      )}
    </InspectorSection>
  );
}

export function IngressRoutes({
  view,
  ingresses,
  onInspect,
}: {
  view: ClusterView;
  ingresses: readonly Entity[];
  onInspect: Inspect;
}) {
  return (
    <ul className="mt-1 space-y-0.5 border-t pt-1">
      {ingresses.map((ingress) => (
        <li
          className="flex flex-wrap items-center gap-x-2 text-xs"
          key={ingress.uid}
        >
          <span className="text-muted-foreground">routed from Ingress</span>
          <Button
            className="h-8 max-w-full justify-start px-0 font-mono text-xs"
            onClick={() => onInspect(view, ingress)}
            variant="link"
          >
            <span className="truncate">{ingress.name}</span>
            <ArrowUpRight aria-hidden className="size-3" />
          </Button>
          <span className="break-all font-mono text-muted-foreground">
            {ingress.hosts?.join(", ") || "no host rules"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Placement({
  view,
  nodes,
  unscheduled,
  onInspect,
}: {
  view: ClusterView;
  nodes: readonly NodePlacement[];
  unscheduled: number;
  onInspect: Inspect;
}) {
  const total = nodes.reduce((sum, item) => sum + item.count, 0);
  return (
    <InspectorSection
      description={`${total} active pod${total === 1 ? "" : "s"} on ${nodes.length} node${nodes.length === 1 ? "" : "s"}, from Pod scheduling.`}
      title="Placement"
    >
      {nodes.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {nodes.map(({ uid, node, count }) => (
            <li key={uid}>
              {node ? (
                <Button
                  aria-label={`Node ${node.name}, ${count} pod${count === 1 ? "" : "s"}`}
                  className="h-8 font-mono text-xs"
                  onClick={() => onInspect(view, node)}
                  size="sm"
                  variant="outline"
                >
                  <Server aria-hidden className="size-3.5" />
                  {node.name}
                  <Badge className="font-sans tabular-nums" variant="secondary">
                    {count}
                  </Badge>
                </Button>
              ) : (
                <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed px-2.5 text-muted-foreground text-xs">
                  Node not in this observation · {count}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {unscheduled > 0 && (
        <p className="text-warning-text text-xs">
          <TriangleAlert
            aria-hidden
            className="mr-1 inline size-3.5 align-[-2px]"
          />
          {unscheduled} pod{unscheduled === 1 ? " is" : "s are"} not scheduled
          on a node.
        </p>
      )}
    </InspectorSection>
  );
}
