import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { cn } from "@jood-monitor/ui/utils";
import {
  Cpu,
  Database,
  Info,
  Server,
  SlidersHorizontal,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";
import {
  captureTime,
  collectionState,
  diagnosticText,
  gapReason,
  profileKnown,
  settingGap,
  type UsageGap,
  usageGap,
} from "../lib/collection-state";
import {
  findEntity,
  type ResourceSummary,
  summarize,
} from "../lib/infrastructure";
import { inventoryFreshness } from "../lib/metrics";
import type { HubClock } from "../lib/time";
import { type PanelTab, panelTabs, type SearchState } from "../schemas/monitor";
import {
  InspectorHeader,
  type LinkContext,
  useInspectionTrail,
} from "./inspector-header";
import {
  activeTab,
  type Coverage,
  type Crumb,
  conditionGroups,
  type InspectorTab,
  inspectionKey,
  inspectorTabs,
  isCohort,
  panelLinks,
  podCoverage,
  podGroups,
  readyText,
  type UsageReading,
  usageReading,
} from "./inspector-model";
import { RelationshipList } from "./inspector-sections";
import {
  type ChangesQuery,
  ChangesTab,
  changesBadge,
  useChangeRows,
  useResourceChanges,
} from "./panel-changes";
import { DetailsTab } from "./panel-details";
import { type HistoryQuery, MetricsTab, useHistory } from "./panel-metrics";
import { PodsTab } from "./panel-pods";
import { PanelShell } from "./panel-shell";

// `extra.panel` opens the resource on that tab.
type Inspect = (
  view: ClusterView,
  entity: Entity,
  extra?: { panel?: PanelTab }
) => void;
type Inspected = { view: ClusterView; entity: Entity } | null;

// Railway's service panel for one resource: header, usage at a glance, and
// tabs for member pods (its Deployments list), metrics, recorded changes,
// details and links. The tab lives in the URL (`panel`).
export function ResourceInspector({
  inspected,
  onClose,
  onInspect,
  onBack,
  panel,
  onPanel,
  search,
  referenceTime,
  range,
  onRange,
  at,
  connection,
  hubClock,
  scope,
  onCollection,
}: {
  inspected: Inspected;
  onClose: () => void;
  onInspect: Inspect;
  // The header's Back to the previous resource in the trail.
  onBack: (crumb: Crumb) => void;
  // The URL's tab; a tab the kind lacks shows the kind's first tab.
  panel?: string;
  onPanel: (tab: PanelTab) => void;
  // The page's search, which links to the panel carry.
  search: SearchState;
  referenceTime: number;
  range: string;
  // Changes the shared history range; without it the Metrics tab shows the
  // range read-only.
  onRange?: (range: string) => void;
  at?: string;
  // The dashboard's monitoring stream state; slows history polling while
  // stream notifications are arriving.
  connection?: string;
  // The snapshot's hub time, which bounds the raw history window.
  hubClock?: HubClock;
  // The dashboard scope (a workspace id or "global"), so stream
  // notifications for that scope refresh the history; defaults to the
  // resource's own workspace.
  scope?: string;
  onCollection: (view: ClusterView, node?: Entity) => void;
}) {
  const trail = useInspectionTrail(inspected);
  const title = useRef<HTMLHeadingElement>(null);
  const live = { at, connection, hubClock, scope, range, referenceTime };
  const cpu = useHistory(inspected, "cpu", live);
  const memory = useHistory(inspected, "memory", live);
  const changes = useResourceChanges(inspected, { at, connection, scope });
  return (
    <PanelShell
      onClose={onClose}
      open={!!inspected}
      resource={
        inspected
          ? {
              key: inspectionKey(inspected.view, inspected.entity),
              label: `${inspected.entity.kind} ${inspected.entity.name}`,
            }
          : undefined
      }
      title={title}
    >
      {inspected && (
        <InspectorBody
          changes={changes}
          cpu={cpu}
          entity={inspected.entity}
          frozen={!!at}
          hubClock={hubClock}
          memory={memory}
          onBack={onBack}
          onCollection={onCollection}
          onInspect={onInspect}
          onPanel={onPanel}
          onRange={onRange}
          panel={panel}
          range={range}
          referenceTime={referenceTime}
          search={search}
          title={title}
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
  changes: "Changes",
  details: "Details",
  links: "Links",
};

function panelTab(value: string) {
  return panelTabs.find((tab) => tab === value);
}

// Pods, Nodes and kinds summed over member pods have usage to glance at.
function hasUsage(kind: string) {
  return kind === "Pod" || kind === "Node" || isCohort(kind);
}

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
  changes,
  panel,
  onPanel,
  onInspect,
  onBack,
  onCollection,
  search,
  hubClock,
  title,
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
  changes: ChangesQuery;
  panel?: string;
  onPanel: (tab: PanelTab) => void;
  onInspect: Inspect;
  onBack: (crumb: Crumb) => void;
  onCollection: (view: ClusterView, node?: Entity) => void;
  search: SearchState;
  hubClock?: HubClock;
  title: RefObject<HTMLHeadingElement | null>;
}) {
  const summary = summarize(view, entity, referenceTime);
  const gap = usageGap(view, entity, summary.pods, referenceTime, frozen);
  const coverage = podCoverage(summary, gap);
  const links = panelLinks(view, entity);
  const stale =
    inventoryFreshness(view.inventory.sourceTime, referenceTime) !== "fresh";
  const profile = profileKnown(view, frozen)
    ? collectionState(view, referenceTime).label
    : undefined;
  // The URL's tab; each kind shows it when it has that tab.
  const tabs = inspectorTabs(entity.kind, links.length > 0);
  const tab = activeTab(panel, entity.kind, links.length > 0);
  const related = useChangeRows(changes.data, view, entity);
  const scroller = useRef<HTMLDivElement>(null);
  const key = inspectionKey(view, entity);
  // Fetch the chart code while the operator reads the first tab.
  useEffect(() => {
    import("./resource-chart").catch(() => undefined);
  }, []);
  useEffect(() => {
    if (key) {
      const region = scroller.current;
      region?.scrollTo({ top: 0 });
      region?.closest("[data-slot=sheet-content]")?.scrollTo({ top: 0 });
    }
  }, [key]);
  const select = (value: string) => {
    const next = panelTab(value);
    if (next) {
      onPanel(next);
    }
    scroller.current?.scrollTo({ top: 0 });
  };
  const counts: Partial<Record<InspectorTab, number | string>> = {
    pods: summary.pods.length,
    changes: changesBadge(related, changes.data != null),
    links: links.length,
  };
  const warnings: Partial<Record<InspectorTab, number>> = {
    pods: podGroups(summary.pods, referenceTime).attention.length,
    details: conditionGroups(entity.conditions).abnormal.length,
  };
  const link: LinkContext = { search, panel: tab, hubClock };
  return (
    <>
      <div className="shrink-0 space-y-4 pb-5">
        <InspectorHeader
          entity={entity}
          link={link}
          onBack={onBack}
          onInspect={onInspect}
          referenceTime={referenceTime}
          titleRef={title}
          trail={trail}
          view={view}
        />
        {hasUsage(entity.kind) && (
          <UsageStrip coverage={coverage} entity={entity} summary={summary} />
        )}
        <CollectionNotice
          entity={entity}
          frozen={frozen}
          gap={summary.cpu == null || summary.memory == null ? gap : undefined}
          now={referenceTime}
          onCollection={onCollection}
          view={view}
        />
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
                frozen={frozen}
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
                frozen={frozen}
                memory={memory}
                now={referenceTime}
                // The pod opens on its own Metrics tab.
                onPodHistory={(pod) =>
                  onInspect(view, pod, { panel: "metrics" })
                }
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
          {tabs.includes("changes") && (
            <TabsContent className="px-4 py-5 sm:px-6" value="changes">
              <ChangesTab
                changes={related}
                entity={entity}
                onInspect={onInspect}
                query={changes}
                stale={stale}
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

function TabBadges({
  count,
  warnings,
}: {
  count?: number | string;
  warnings?: number;
}) {
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

// The Diagnostic running on this Node at `time`, if any.
function diagnosticOn(view: ClusterView, entity: Entity, time: number) {
  if (entity.kind !== "Node") {
    return;
  }
  const running = collectionState(view, time).diagnostic;
  return running?.nodeUids.includes(entity.uid) ? running : undefined;
}

// Whether a saved observation's captured settings show a Diagnostic running
// on this Node when its inventory was captured. Judged at the capture, never
// the selected time or the clock; without captured settings, no claim.
export function capturedDiagnostic(view: ClusterView, entity: Entity) {
  const capture = captureTime(view);
  return (
    profileKnown(view, true) &&
    capture != null &&
    !!diagnosticOn(view, entity, capture)
  );
}

// Why usage is missing when the hub knows, with a way to the collection
// settings when they cause it, and a Diagnostic running on this Node: live,
// with its countdown; saved, as its captured settings show it. The display
// clock is zero until hydration, so the countdown waits for it.
function CollectionNotice({
  view,
  entity,
  gap,
  frozen,
  now,
  onCollection,
}: {
  view: ClusterView;
  entity: Entity;
  gap?: UsageGap;
  frozen: boolean;
  now: number;
  onCollection: (view: ClusterView, node?: Entity) => void;
}) {
  const diagnostic =
    !frozen && now > 0 ? diagnosticOn(view, entity, now) : undefined;
  const captured = frozen && capturedDiagnostic(view, entity);
  if (!(gap || diagnostic || captured)) {
    return null;
  }
  const node =
    entity.kind === "Node" ? entity : findEntity(view, entity.nodeUid);
  return (
    <div className="px-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-xs">
        <ul className="min-w-0 flex-1 space-y-1">
          {gap && (
            <li className="flex items-start gap-2">
              <Info
                aria-hidden
                className="mt-px size-3.5 shrink-0 text-info-text"
              />
              {gapReason(gap)}
            </li>
          )}
          {diagnostic && (
            <li className="flex items-start gap-2">
              <Timer
                aria-hidden
                className="mt-px size-3.5 shrink-0 text-info-text"
              />
              {diagnosticText(diagnostic, now)}.
            </li>
          )}
          {captured && (
            <li className="flex items-start gap-2">
              <Timer
                aria-hidden
                className="mt-px size-3.5 shrink-0 text-info-text"
              />
              The settings captured with this inventory show a Diagnostic
              running on this node when it was captured.
            </li>
          )}
        </ul>
        {gap && settingGap(gap) && !frozen && (
          <Button
            className="h-8 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onCollection(view, node)}
            size="sm"
            variant="outline"
          >
            <SlidersHorizontal aria-hidden />
            Change collection
          </Button>
        )}
      </div>
    </div>
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
