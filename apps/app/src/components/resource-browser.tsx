import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { lazy, Suspense, useCallback } from "react";
import { isSystemNamespace } from "../lib/infrastructure";
import type { ResourceFilter } from "../lib/resource-table";
import type { TopologyLayout } from "../lib/service-graph";
import { defaultPageSize, type SearchState } from "../schemas/monitor";
import { ResourceFilterBar } from "./resource-filter-bar";
import { Resources } from "./resources";
import { Servers } from "./servers";

const Topology = lazy(() =>
  import("./topology").then((module) => ({ default: module.Topology }))
);

type Update = (next: Partial<SearchState>, replace?: boolean) => void;

interface ResourcePageProps {
  inspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  search: SearchState;
  // `replace` keeps filter edits out of browser history; view, mode and tab
  // changes push entries so Back returns to the previous screen.
  update: Update;
  views: ClusterView[];
}

export function ResourceBrowser({
  search,
  views,
  allViews,
  inspect,
  update,
  referenceTime,
  namespaces,
}: ResourcePageProps & { allViews: ClusterView[]; namespaces: string[] }) {
  return (
    <>
      <ResourceFilterBar
        allViews={allViews}
        namespaces={namespaces}
        search={search}
        update={update}
        views={views}
      />
      <ResourceViews
        inspect={inspect}
        referenceTime={referenceTime}
        search={search}
        update={update}
        views={views}
      />
    </>
  );
}

const workloadTabs: Record<string, string[]> = {
  workloads: ["Deployment", "StatefulSet", "DaemonSet"],
  pods: ["Pod"],
  services: ["Service"],
};

function ResourceViews({
  search,
  views,
  inspect,
  update,
  referenceTime,
}: ResourcePageProps) {
  const relax = useCallback(
    (patch: Partial<ResourceFilter>) => update(patch, true),
    [update]
  );
  const pageSize = useCallback(
    (size: number) =>
      update({ pageSize: size === defaultPageSize ? undefined : size }, true),
    [update]
  );
  // Stable callbacks keep the topology from rebuilding every card when this
  // page re-renders for unrelated reasons. Drilling into a namespace is
  // navigation, so Back returns to the map.
  const drill = useCallback(
    (namespace: string) => update({ namespace }),
    [update]
  );
  // The Graph/List choice lives in the URL, so it survives the topology's
  // remount; choosing it replaces the entry rather than adding one.
  const chooseLayout = useCallback(
    (layout: TopologyLayout) => update({ layout }, true),
    [update]
  );
  const includeSystem = useCallback(
    () => update({ system: true }, true),
    [update]
  );
  const common = {
    onInspect: inspect,
    referenceTime,
    views,
    search: search.q,
    namespace: search.namespace,
    // Choosing a system namespace explicitly includes system resources.
    showSystem: search.system || isSystemNamespace(search.namespace),
    problems: search.problems,
  };
  const table = {
    ...common,
    onRelax: relax,
    pageSize: search.pageSize,
    onPageSizeChange: pageSize,
  };
  if (search.view === "workloads") {
    return (
      <Tabs
        onValueChange={(tab) => update({ tab: String(tab) })}
        value={workloadTabs[search.tab] ? search.tab : "workloads"}
      >
        <TabsList>
          <TabsTrigger value="workloads">Workloads</TabsTrigger>
          <TabsTrigger value="pods">Pods</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
        </TabsList>
        {Object.entries(workloadTabs).map(([tab, kinds]) => (
          <TabsContent className="mt-4" key={tab} value={tab}>
            <Resources {...table} kinds={kinds} />
          </TabsContent>
        ))}
      </Tabs>
    );
  }
  if (search.mode === "services") {
    return (
      <Suspense
        fallback={
          <div className="p-6 text-muted-foreground text-sm" role="status">
            Loading topology…
          </div>
        }
      >
        <Topology
          {...common}
          key={`${search.workspace}:${search.cluster ?? "all"}:${search.namespace}:${search.at ? "frozen" : "live"}`}
          layout={search.layout}
          onLayout={chooseLayout}
          onNamespace={drill}
          onShowSystem={includeSystem}
        />
      </Suspense>
    );
  }
  if (search.mode === "servers") {
    return <Servers {...common} onRelax={relax} />;
  }
  return <Resources {...table} kind={search.kind} preset="list" />;
}
