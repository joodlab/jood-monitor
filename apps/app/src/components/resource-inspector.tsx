import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { cn } from "@jood-monitor/ui/utils";
import { Cpu, Database, Server, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ResourceSummary, summarize } from "../lib/infrastructure";
import { inventoryFreshness } from "../lib/metrics";
import { InspectorHeader, useInspectionTrail } from "./inspector-header";
import {
  activeTab,
  type Coverage,
  type Crumb,
  conditionGroups,
  type InspectorTab,
  inspectionKey,
  inspectorTabs,
  isCohort,
  podCoverage,
  podGroups,
  readyText,
  relationships,
  type UsageReading,
  usageReading,
} from "./inspector-model";
import { RelationshipList } from "./inspector-sections";
import { DetailsTab } from "./panel-details";
import { type HistoryQuery, MetricsTab, useHistory } from "./panel-metrics";
import { PodsTab } from "./panel-pods";
import { PanelShell } from "./panel-shell";

type Inspect = (view: ClusterView, entity: Entity) => void;
type Inspected = { view: ClusterView; entity: Entity } | null;

// Railway's service panel for one resource: header, usage at a glance, and
// tabs for member pods (its Deployments list), metrics, details and links.
export function ResourceInspector({
  inspected,
  onClose,
  onInspect,
  referenceTime,
  range,
  onRange,
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
  // Changes the shared history range; without it the Metrics tab shows the
  // range read-only.
  onRange?: (range: string) => void;
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
  const trail = useInspectionTrail(inspected);
  const live = { at, connection, scope, range, referenceTime };
  const cpu = useHistory(inspected, "cpu", live);
  const memory = useHistory(inspected, "memory", live);
  return (
    <PanelShell onClose={onClose} open={!!inspected}>
      {inspected && (
        <InspectorBody
          cpu={cpu}
          entity={inspected.entity}
          frozen={!!at}
          memory={memory}
          onCollection={onCollection}
          onInspect={onInspect}
          onRange={onRange}
          range={range}
          referenceTime={referenceTime}
          trail={trail}
          view={inspected.view}
        />
      )}
    </PanelShell>
  );
}

const tabNames: Record<InspectorTab, string> = {
  pods: "Pods",
  metrics: "Metrics",
  details: "Details",
  links: "Links",
};

const listClass =
  "sticky top-0 z-10 w-full shrink-0 justify-start gap-5 overflow-x-auto rounded-none border-b bg-popover p-0 px-4 group-data-[orientation=horizontal]/tabs:h-12 sm:px-6 md:static";
const triggerClass =
  "h-full flex-none rounded-none px-1 text-sm after:bg-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-data-[orientation=horizontal]/tabs:after:bottom-0 sm:text-[15px]";

function InspectorBody({
  view,
  entity,
  trail,
  referenceTime,
  frozen,
  range,
  onRange,
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
  range: string;
  onRange?: (range: string) => void;
  cpu: HistoryQuery;
  memory: HistoryQuery;
  onInspect: Inspect;
  onCollection: (view: ClusterView, node?: Entity) => void;
}) {
  const summary = summarize(view, entity, referenceTime);
  const coverage = podCoverage(summary);
  const links = relationships(view, entity);
  const stale =
    inventoryFreshness(view.inventory.sourceTime, referenceTime) !== "fresh";
  const profile = frozen ? undefined : view.profile.name;
  // The operator's tab choice; each kind shows it when it has that tab.
  const [chosen, setChosen] = useState<string>();
  const tabs = inspectorTabs(entity.kind);
  const tab = activeTab(chosen, entity.kind);
  const scroller = useRef<HTMLDivElement>(null);
  const key = inspectionKey(view, entity);
  useEffect(() => {
    if (key) {
      const region = scroller.current;
      region?.scrollTo({ top: 0 });
      region?.closest("[data-slot=sheet-content]")?.scrollTo({ top: 0 });
    }
  }, [key]);
  const select = (value: string) => {
    setChosen(value);
    scroller.current?.scrollTo({ top: 0 });
  };
  const counts: Partial<Record<InspectorTab, number>> = {
    pods: summary.pods.length,
    links: links.length,
  };
  const warnings: Partial<Record<InspectorTab, number>> = {
    pods: podGroups(summary.pods, referenceTime).attention.length,
    details: conditionGroups(entity.conditions).abnormal.length,
  };
  return (
    <>
      <div className="shrink-0 space-y-4 pb-5">
        <InspectorHeader
          entity={entity}
          onInspect={onInspect}
          referenceTime={referenceTime}
          trail={trail}
          view={view}
        />
        {(entity.kind === "Pod" ||
          entity.kind === "Node" ||
          isCohort(entity.kind)) && (
          <UsageStrip coverage={coverage} entity={entity} summary={summary} />
        )}
        <AbnormalConditions
          conditions={entity.conditions}
          onShow={() => select("details")}
        />
      </div>
      <Tabs
        className="gap-0 md:min-h-0 md:flex-1"
        onValueChange={(value) => select(String(value))}
        value={tab}
      >
        <TabsList
          aria-label={`${entity.kind} ${entity.name} sections`}
          className={listClass}
          variant="line"
        >
          {tabs.map((item) => (
            <TabsTrigger className={triggerClass} key={item} value={item}>
              {tabNames[item]}
              <TabBadges count={counts[item]} warnings={warnings[item]} />
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto" ref={scroller}>
          {tabs.includes("pods") && (
            <TabsContent className="px-4 py-5 sm:px-6" value="pods">
              <PodsTab
                coverage={coverage}
                entity={entity}
                now={referenceTime}
                onInspect={onInspect}
                profile={profile}
                stale={stale}
                summary={summary}
                view={view}
              />
            </TabsContent>
          )}
          {tabs.includes("metrics") && (
            <TabsContent className="px-4 py-5 sm:px-6" value="metrics">
              <MetricsTab
                coverage={coverage}
                cpu={cpu}
                entity={entity}
                memory={memory}
                now={referenceTime}
                onPodHistory={(pod) => {
                  setChosen("metrics");
                  onInspect(view, pod);
                }}
                onRange={onRange}
                onShowPods={() => select("pods")}
                profile={profile}
                range={range}
                stale={stale}
                summary={summary}
                view={view}
              />
            </TabsContent>
          )}
          <TabsContent className="px-4 py-5 sm:px-6" value="details">
            <DetailsTab
              entity={entity}
              frozen={frozen}
              onCollection={onCollection}
              onInspect={onInspect}
              referenceTime={referenceTime}
              summary={summary}
              view={view}
            />
          </TabsContent>
          {tabs.includes("links") && (
            <TabsContent className="px-4 py-5 sm:px-6" value="links">
              <RelationshipList
                entity={entity}
                links={links}
                onInspect={onInspect}
                view={view}
              />
            </TabsContent>
          )}
        </div>
      </Tabs>
    </>
  );
}

function TabBadges({ count, warnings }: { count?: number; warnings?: number }) {
  return (
    <>
      {count != null && (
        <span className="rounded-full bg-muted px-1.5 font-normal text-muted-foreground text-xs tabular-nums">
          {count}
        </span>
      )}
      {warnings ? (
        <>
          <TriangleAlert aria-hidden className="size-3.5 text-warning-text" />
          <span className="sr-only">
            , {warnings} {warnings === 1 ? "needs" : "need"} attention
          </span>
        </>
      ) : null}
    </>
  );
}

// Abnormal conditions are status, so they stay in view on every tab.
function AbnormalConditions({
  conditions,
  onShow,
}: {
  conditions?: Entity["conditions"];
  onShow: () => void;
}) {
  const { abnormal } = conditionGroups(conditions);
  if (!abnormal.length) {
    return null;
  }
  return (
    <div className="px-4 sm:px-6">
      <button
        className="group flex w-full items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-left text-xs outline-none transition-colors hover:bg-warning/10 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onShow}
        type="button"
      >
        <TriangleAlert
          aria-hidden
          className="mt-px size-3.5 shrink-0 text-warning-text"
        />
        <span className="min-w-0 flex-1">
          <span className="font-medium">
            {abnormal.length} abnormal condition
            {abnormal.length === 1 ? "" : "s"}:
          </span>{" "}
          {abnormal
            .map(
              (condition) =>
                `${condition.type} ${condition.status}${condition.reason ? ` (${condition.reason})` : ""}`
            )
            .join(", ")}
        </span>
        <span className="shrink-0 text-muted-foreground underline-offset-2 group-hover:underline">
          View details
        </span>
      </button>
    </div>
  );
}

// Current usage at a glance. Workload, Service and Namespace values are sums
// over member pods, a labelled lower bound when coverage is partial.
function UsageStrip({
  entity,
  summary,
  coverage,
}: {
  entity: Entity;
  summary: ResourceSummary;
  coverage: Coverage;
}) {
  const total = isCohort(entity.kind);
  return (
    <div className="px-4 sm:px-6">
      <dl className="grid grid-cols-3 divide-x rounded-lg border bg-background/40">
        <Stat
          icon={Cpu}
          label={total ? "CPU (sum)" : "CPU used"}
          reading={usageReading("cpu", entity, summary, coverage)}
        />
        <Stat
          icon={Database}
          label={total ? "Memory (sum)" : "Memory used"}
          reading={usageReading("memory", entity, summary, coverage)}
        />
        <Stat
          icon={Server}
          label={entity.kind === "Node" ? "Pods ready" : "Ready"}
          reading={{
            value: readyText(summary),
            missing: summary.ready == null,
          }}
        />
      </dl>
    </div>
  );
}

function Stat({
  label,
  reading,
  icon: Icon,
}: {
  label: string;
  reading: UsageReading;
  icon: typeof Cpu;
}) {
  return (
    <div className="min-w-0 px-3 py-2.5 sm:px-4">
      <dt className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </dt>
      <dd
        className={cn(
          "mt-1 tabular-nums",
          reading.missing
            ? "text-muted-foreground text-sm"
            : "font-semibold text-base sm:text-lg"
        )}
      >
        {reading.value}
      </dd>
      {reading.detail && (
        <dd className="text-muted-foreground text-xs tabular-nums">
          {reading.detail}
        </dd>
      )}
    </div>
  );
}
