import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import {
  ArrowUpRight,
  ChevronDown,
  Globe,
  HeartPulse,
  Info,
  type LucideIcon,
  Server,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  type Coverage,
  conditionGroups,
  coverageText,
  type Exposure,
  type NodePlacement,
  type Relationship,
  relationText,
  splitRevisions,
} from "./inspector-model";

type Inspect = (view: ClusterView, entity: Entity) => void;
type Condition = NonNullable<Entity["conditions"]>[number];

// A section in the style of Railway's service settings: a circular icon on a
// vertical rail, the title and description, then the content. The rail
// joins consecutive sections and stops after the last one.
export function InspectorSection({
  title,
  description,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="group/section flex gap-4">
      {Icon && (
        <div aria-hidden className="hidden flex-col items-center sm:flex">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-popover text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <span className="mt-2 w-px flex-1 bg-border group-last/section:hidden" />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-3 pb-8 group-last/section:pb-0">
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <h3 className="font-medium text-base leading-tight">{title}</h3>
            {description && (
              <p className="mt-0.5 text-muted-foreground text-xs">
                {description}
              </p>
            )}
          </div>
          {action}
        </div>
        {children}
      </div>
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
    <InspectorSection icon={HeartPulse} title="Conditions">
      {abnormal.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
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

// Explains missing or partial totals with counts and the reason the hub
// knows. Finished pods never count against coverage.
export function CoverageNote({
  coverage,
  profile,
}: {
  coverage: Coverage;
  // Label of the collection profile in effect, when known.
  profile?: string;
}) {
  const note = coverageText(coverage, profile);
  if (!note) {
    return null;
  }
  if (!note.partial) {
    return <p className="text-muted-foreground text-xs">{note.text}</p>;
  }
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-info/30 bg-info/5 p-2 text-xs">
      <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info-text" />
      <span>{note.text}</span>
    </p>
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
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">
          {relationText(link, entity)}
        </p>
        {other ? (
          <Button
            className="h-8 max-w-full justify-start px-0 font-mono text-sm"
            onClick={() => onInspect(view, other)}
            variant="link"
          >
            <span className="truncate">{other.name}</span>
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Button>
        ) : (
          <p className="py-1.5 text-xs">
            Not in this observation ·{" "}
            <span className="font-mono">
              {link.outgoing ? link.edge.target : link.edge.source}
            </span>
          </p>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Evidence: {link.edge.evidence || "not reported"}
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
      <p className="rounded-lg border border-dashed py-8 text-center text-muted-foreground text-sm">
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
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {current.length} configured relationship
        {current.length === 1 ? "" : "s"}. Configured and discovered structure,
        not measured traffic.
      </p>
      <ul className="divide-y rounded-lg border bg-background/40">
        {current.map(item)}
      </ul>
      {previous.length > 0 && (
        <div className="-mx-2">
          <Disclosure label={`Previous revisions (${previous.length})`}>
            <ul className="mx-2 divide-y rounded-lg border bg-background/40">
              {previous.map(item)}
            </ul>
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
      icon={Globe}
      title="Exposed by"
    >
      {exposures.length ? (
        <ul className="space-y-2">
          {exposures.map(({ service, ingresses }) => (
            <li
              className="rounded-lg border bg-background/40 p-3"
              key={service.uid}
            >
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
      icon={Server}
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
