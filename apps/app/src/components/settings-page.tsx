import type { ClusterView } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@jood-monitor/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { cn } from "@jood-monitor/ui/utils";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Boxes,
  Database,
  MonitorCog,
  Server,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { fetchWorkspaces } from "../hooks/api/clusters";
import { type Theme, useDisplay } from "../hooks/display";
import { freshness } from "../lib/metrics";
import { stagedClusters, useStagedState } from "../lib/staged-changes";
import {
  type TimeZonePreference,
  timeZoneLabel,
  timeZoneOptions,
} from "../lib/time";
import type { SearchState } from "../schemas/monitor";
import { ClusterSettings } from "./collection-cluster";
import { capabilityLabel, clusterNodes } from "./collection-model";
import { EmptyState } from "./page";
import { SettingsRail, StagedPill } from "./settings-rail";
import { StagedChangesBar } from "./staged-changes";

// Railway-style settings: a section list on the left (one entry per cluster
// plus workspace and display), the selected section's rails on the right,
// and the floating staged-changes card. Collection edits are staged, never
// applied directly from a field.

const workspaceSection = "workspace";

function clusterSection(id: string) {
  return `cluster:${id}`;
}

// The section last opened in this tab, so returning to Settings keeps it.
let rememberedSection: string | undefined;

function heartbeatText(view: ClusterView, now: number) {
  const state = freshness(view.cluster.heartbeatAt, now);
  if (state === "unknown") {
    return "No heartbeat yet";
  }
  return state === "fresh" ? "Heartbeat fresh" : `Heartbeat ${state}`;
}

function heartbeatDot(view: ClusterView, now: number) {
  const state = freshness(view.cluster.heartbeatAt, now);
  if (state === "unknown") {
    return "bg-muted-foreground";
  }
  return state === "fresh" ? "bg-success" : "bg-warning";
}

const sectionTrigger =
  "h-auto min-h-11 w-full flex-none justify-start gap-2.5 rounded-md px-2.5 py-2 text-left font-normal text-muted-foreground hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring data-active:bg-muted data-active:text-foreground dark:data-active:border-transparent dark:data-active:bg-muted";

function ClusterEntry({ view, staged }: { view: ClusterView; staged: number }) {
  const { now } = useDisplay();
  return (
    <TabsTrigger
      className={sectionTrigger}
      value={clusterSection(view.cluster.id)}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", heartbeatDot(view, now))}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground text-sm">
          {view.cluster.name}
        </span>
        <span className="block truncate text-xs">
          {view.cluster.environment || "No environment"} ·{" "}
          {heartbeatText(view, now)}
        </span>
      </span>
      {staged > 0 && (
        <>
          <span aria-hidden>
            <StagedPill>{staged}</StagedPill>
          </span>
          <span className="sr-only">
            , {staged} staged change{staged === 1 ? "" : "s"}
          </span>
        </>
      )}
    </TabsTrigger>
  );
}

// The left column: the staged-changes card on top (Railway's top-left
// banner; a floating bottom card on small screens), then the sections.
function SectionList({
  views,
  clusterFilter,
}: {
  views: ClusterView[];
  clusterFilter?: string;
}) {
  const { now } = useDisplay();
  const staged = useStagedState();
  const list = useRef<HTMLDivElement>(null);
  const counts = new Map(
    (now ? stagedClusters(staged, views, now) : []).map((cluster) => [
      cluster.view.cluster.id,
      cluster.rows.length,
    ])
  );
  return (
    <div className="space-y-3 lg:sticky lg:top-28 lg:self-start" ref={list}>
      <StagedChangesBar
        className="max-lg:fixed max-lg:right-4 max-lg:bottom-4 max-lg:z-30 lg:w-full"
        // The selected section is a visible place to land once the last
        // staged change is discarded with focus inside the card.
        focusFallback={() =>
          list.current?.querySelector<HTMLElement>(
            '[role="tab"][aria-selected="true"]'
          )
        }
      />
      <TabsList
        aria-label="Settings sections"
        className="h-auto w-full items-stretch gap-0.5 bg-transparent p-0 lg:max-h-[calc(100svh-20rem)] lg:overflow-y-auto"
      >
        <p
          aria-hidden
          className="px-2.5 pt-1 pb-1.5 font-medium text-muted-foreground text-xs"
        >
          Clusters
        </p>
        {views.map((view) => (
          <ClusterEntry
            key={view.cluster.id}
            staged={counts.get(view.cluster.id) ?? 0}
            view={view}
          />
        ))}
        <p
          aria-hidden
          className="px-2.5 pt-3 pb-1.5 font-medium text-muted-foreground text-xs"
        >
          General
        </p>
        <TabsTrigger className={sectionTrigger} value={workspaceSection}>
          <MonitorCog aria-hidden className="size-4 shrink-0" />
          <span className="font-medium text-foreground text-sm">
            Workspace & display
          </span>
        </TabsTrigger>
      </TabsList>
      {clusterFilter && (
        <p className="px-2.5 text-muted-foreground text-xs">
          Showing the cluster chosen in the top bar. Choose All clusters there
          to list every cluster in this workspace.
        </p>
      )}
    </div>
  );
}

function SourcesRail({ views }: { views: ClusterView[] }) {
  return (
    <SettingsRail
      description="What each observer reports it can collect. Topology shows configured and discovered structure, not traffic."
      icon={Database}
      title="Sources"
    >
      <div className="space-y-1 text-sm">
        <p>
          Kubernetes inventory, owner references, EndpointSlices, ingress routes
          and supported resource metrics.
        </p>
        <p className="text-muted-foreground text-xs">
          Service connections and HTTP request metrics require another measured
          source. Beyla and tracing are deferred.
        </p>
      </div>
      <ul className="space-y-2">
        {views.map((view) => {
          const capabilities = view.heartbeat.capabilities ?? [];
          return (
            <li
              className="flex flex-wrap items-center gap-1.5 text-xs"
              key={view.cluster.id}
            >
              <span className="mr-1 font-medium">{view.cluster.name}</span>
              {capabilities.length ? (
                capabilities.map((capability) => (
                  <Badge
                    key={capability}
                    variant={
                      capability.endsWith("_unavailable")
                        ? "warning"
                        : "outline"
                    }
                  >
                    {capability.endsWith("_unavailable") && (
                      <TriangleAlert aria-hidden />
                    )}
                    {capabilityLabel(capability)}
                  </Badge>
                ))
              ) : (
                <span className="text-muted-foreground">Not reported yet</span>
              )}
            </li>
          );
        })}
      </ul>
      <a
        className="inline-flex items-center gap-1.5 rounded-sm text-primary text-xs underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href="/docs/metrics"
      >
        <BookOpen aria-hidden className="size-3.5" />
        Metrics and collection documentation
      </a>
    </SettingsRail>
  );
}

const zoneNames: Record<TimeZonePreference, string> = {
  local: "Browser time",
  UTC: "UTC",
  "Asia/Riyadh": "Riyadh",
};

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const uid = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend className="font-medium text-sm">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label
            className={cn(
              "inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              value === option.value
                ? "border-primary bg-primary/10"
                : "hover:bg-muted/50"
            )}
            key={option.value}
          >
            <input
              checked={value === option.value}
              className="sr-only"
              name={`${uid}-choice`}
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function DisplayRail() {
  const display = useDisplay();
  return (
    <SettingsRail
      description="Stored in this browser only. Times always show their zone; hover or focus a time for the exact value."
      icon={MonitorCog}
      title="Display"
    >
      <ChoiceGroup<Theme>
        label="Theme"
        onChange={display.setTheme}
        options={[
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ]}
        value={display.theme}
      />
      <ChoiceGroup<TimeZonePreference>
        label={`Time zone · ${timeZoneLabel(display.timeZone)}`}
        onChange={display.setTimeZonePreference}
        options={timeZoneOptions.map((option) => ({
          value: option,
          label: zoneNames[option],
        }))}
        value={display.timeZonePreference}
      />
    </SettingsRail>
  );
}

function WorkspacePanel({
  views,
  scopeName,
}: {
  views: ClusterView[];
  scopeName: string;
}) {
  const nodes = views.reduce(
    (count, view) => count + clusterNodes(view).length,
    0
  );
  return (
    <div className="space-y-4">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-card text-muted-foreground"
        >
          <Boxes className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-xl tracking-tight">
            Workspace & display
          </h2>
          <p className="text-muted-foreground text-xs">
            {scopeName} · {views.length} cluster{views.length === 1 ? "" : "s"}{" "}
            · {nodes} node{nodes === 1 ? "" : "s"} in inventory
          </p>
        </div>
      </div>
      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <SourcesRail views={views} />
        <DisplayRail />
        <SettingsRail
          description="Workspaces group clusters and scope what you see. Switch workspace or cluster from the top bar, and connect a cluster from this page's header."
          icon={Server}
          last
          title="Clusters"
        >
          <p className="text-muted-foreground text-xs">
            Each cluster's observer, collection profile, diagnostics and
            enrollment are in its own section on the left.
          </p>
        </SettingsRail>
      </div>
    </div>
  );
}

function initialSection(search: SearchState, sections: string[]) {
  const requested = search.cluster && clusterSection(search.cluster);
  if (requested && sections.includes(requested)) {
    return requested;
  }
  if (rememberedSection && sections.includes(rememberedSection)) {
    return rememberedSection;
  }
  return sections[0] ?? workspaceSection;
}

function FrozenSettings({ onResumeLive }: { onResumeLive: () => void }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Collection status is not retained historically</CardTitle>
          <CardDescription>
            Saved observations retain inventory and metrics. Resume live to
            inspect collection acknowledgments and to stage or apply profile
            changes. Changes are only available live.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onResumeLive}
          >
            Resume live
          </Button>
        </CardContent>
      </Card>
      <StagedChangesBar />
    </div>
  );
}

export function CollectionSettings({
  search,
  views,
  onResumeLive,
}: {
  search: SearchState;
  views: ClusterView[];
  onResumeLive: () => void;
}) {
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });
  const sections = [
    ...views.map((view) => clusterSection(view.cluster.id)),
    workspaceSection,
  ];
  const [selected, setSelected] = useState(() =>
    initialSection(search, sections)
  );
  // Links that name a cluster (attention items, the inspector) open it.
  useEffect(() => {
    if (search.cluster) {
      setSelected(clusterSection(search.cluster));
    }
  }, [search.cluster]);
  if (search.at) {
    return <FrozenSettings onResumeLive={onResumeLive} />;
  }
  if (!views.length) {
    return (
      <EmptyState
        description={
          search.cluster
            ? "This cluster is not in the selected workspace. Clear the cluster filter or switch workspace."
            : "Use Connect cluster to register a cluster and install its observer. Collection settings appear here once it is registered."
        }
        icon={Server}
        title={
          search.cluster ? "Cluster not found" : "No clusters connected yet"
        }
      />
    );
  }
  const names = Object.fromEntries(
    (workspaces.data ?? []).map((item) => [item.id, item.name])
  );
  const active = sections.includes(selected) ? selected : sections[0];
  const scopeName =
    search.workspace === "global"
      ? "All workspaces"
      : (names[search.workspace] ?? search.workspace);
  const clusters = views.map((view) => view.cluster);
  return (
    <Tabs
      className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start"
      onValueChange={(value) => {
        rememberedSection = String(value);
        setSelected(String(value));
      }}
      orientation="vertical"
      value={active}
    >
      <SectionList clusterFilter={search.cluster} views={views} />
      <div className="min-w-0 max-w-5xl space-y-4 max-lg:pb-36">
        {views.map((view) => (
          <TabsContent
            key={view.cluster.id}
            value={clusterSection(view.cluster.id)}
          >
            <ClusterSettings
              clusters={clusters}
              initialNodeUid={
                search.cluster === view.cluster.id
                  ? search.diagnosticNode
                  : undefined
              }
              view={view}
              workspaceName={
                names[view.cluster.workspaceId] ?? view.cluster.workspaceId
              }
            />
          </TabsContent>
        ))}
        <TabsContent value={workspaceSection}>
          <WorkspacePanel scopeName={scopeName} views={views} />
        </TabsContent>
      </div>
    </Tabs>
  );
}
