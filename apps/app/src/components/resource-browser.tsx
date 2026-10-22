import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { useCallback } from "react";
import { isSystemNamespace } from "../lib/infrastructure";
import {
  type ResourceFilter,
  type ResourceTab,
  resourceTabFor,
  resourceTabs,
  tabKinds,
} from "../lib/resource-table";
import { defaultPageSize, type SearchState } from "../schemas/monitor";
import { ResourceFilterBar } from "./resource-filter-bar";
import { Resources } from "./resources";
import { Servers } from "./servers";

type Update = (next: Partial<SearchState>, replace?: boolean) => void;

interface ResourcePageProps {
  inspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  search: SearchState;
  // `replace` keeps filter edits out of browser history; tab changes push
  // entries so Back returns to the previous tab.
  update: Update;
  views: ClusterView[];
}

// The Resources tab: Railway-style underline sub-tabs (Servers, Workloads,
// Pods, Services, All) over one shared filter bar. The tab comes from the
// project tab in the URL; the previous Infrastructure/Workloads search shape
// is still understood (see resourceTabFor). The topology map that used to
// live here is the Architecture canvas.
export function ResourceBrowser({
  search,
  views,
  inspect,
  update,
  referenceTime,
  namespaces,
}: ResourcePageProps & {
  // No longer read: the cluster is chosen in the project bar. Accepted so
  // existing callers keep compiling.
  allViews?: ClusterView[];
  namespaces: string[];
}) {
  const tab = resourceTabFor(search);
  const props = { inspect, referenceTime, search, update, views };
  return (
    <Tabs
      className="gap-4"
      onValueChange={(next) => {
        if (next !== tab) {
          update({ tab: String(next) });
        }
      }}
      value={tab}
    >
      <ResourceTabList />
      <ResourceFilterBar
        namespaces={namespaces}
        search={search}
        tab={tab}
        update={update}
        views={views}
      />
      {resourceTabs.map((item) => (
        <TabsContent key={item.id} value={item.id}>
          {item.id === tab && <TabView {...props} tab={item.id} />}
        </TabsContent>
      ))}
    </Tabs>
  );
}

// The rule under the tabs is an inset shadow, so the active underline draws
// over it and the row still scrolls sideways on narrow screens.
const tabListClass =
  "w-full justify-start gap-0 overflow-x-auto overflow-y-hidden p-0 shadow-[inset_0_-1px_0_var(--color-border)] group-data-[orientation=horizontal]/tabs:h-10";

const tabTriggerClass =
  "h-10 flex-none rounded-none border-0 px-2.5 font-normal text-muted-foreground text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-active:text-foreground sm:px-3 group-data-[orientation=horizontal]/tabs:after:inset-x-2.5 group-data-[orientation=horizontal]/tabs:after:bottom-0 sm:group-data-[orientation=horizontal]/tabs:after:inset-x-3";

// Arrow keys move focus between tabs; Enter or Space opens one, so browsing
// the tab list does not add history entries.
function ResourceTabList() {
  return (
    <TabsList
      aria-label="Resource type"
      className={tabListClass}
      variant="line"
    >
      {resourceTabs.map((item) => (
        <TabsTrigger className={tabTriggerClass} key={item.id} value={item.id}>
          {item.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function useTableCallbacks(update: Update) {
  const relax = useCallback(
    (patch: Partial<ResourceFilter>) => update(patch, true),
    [update]
  );
  const pageSize = useCallback(
    (size: number) =>
      update({ pageSize: size === defaultPageSize ? undefined : size }, true),
    [update]
  );
  return { relax, pageSize };
}

function commonProps({
  search,
  views,
  inspect,
  referenceTime,
}: ResourcePageProps) {
  return {
    onInspect: inspect,
    referenceTime,
    views,
    search: search.q,
    namespace: search.namespace,
    // Choosing a system namespace explicitly includes system resources.
    showSystem: search.system || isSystemNamespace(search.namespace),
    problems: search.problems,
  };
}

function TabView(props: ResourcePageProps & { tab: ResourceTab }) {
  const { relax, pageSize } = useTableCallbacks(props.update);
  const common = commonProps(props);
  if (props.tab === "servers") {
    return <Servers {...common} onRelax={relax} />;
  }
  const table = {
    ...common,
    onRelax: relax,
    pageSize: props.search.pageSize,
    onPageSizeChange: pageSize,
  };
  if (props.tab === "all") {
    return <Resources {...table} kind={props.search.kind} preset="list" />;
  }
  return <Resources {...table} kinds={tabKinds[props.tab]} />;
}
