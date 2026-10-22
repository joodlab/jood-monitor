import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Input } from "@jood-monitor/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { Search } from "lucide-react";
import { lazy, Suspense } from "react";
import type { SearchState } from "../schemas/monitor";
import { Resources } from "./resources";
import { Servers } from "./servers";

const Topology = lazy(() =>
  import("./topology").then((module) => ({ default: module.Topology }))
);

interface ResourcePageProps {
  inspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  search: SearchState;
  update: (next: Partial<SearchState>) => void;
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
      <div className="flex flex-wrap items-center gap-2">
        {search.view === "infrastructure" && (
          <div className="flex rounded-md border bg-card p-0.5">
            {["services", "servers", "list"].map((mode) => (
              <Button
                className="h-7 text-xs capitalize"
                key={mode}
                onClick={() => update({ mode })}
                size="sm"
                variant={search.mode === mode ? "secondary" : "ghost"}
              >
                {mode}
              </Button>
            ))}
          </div>
        )}
        <Select
          onValueChange={(value) =>
            update({
              cluster: value === "all" ? undefined : (value ?? undefined),
              namespace: "all",
            })
          }
          value={search.cluster ?? "all"}
        >
          <SelectTrigger aria-label="Cluster" className="h-8 w-44 text-xs">
            <SelectValue>
              {search.cluster
                ? allViews.find((view) => view.cluster.id === search.cluster)
                    ?.cluster.name
                : "All clusters"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clusters</SelectItem>
            {allViews.map((view) => (
              <SelectItem key={view.cluster.id} value={view.cluster.id}>
                {view.cluster.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!(search.view === "infrastructure" && search.mode === "servers") && (
          <>
            {" "}
            <Select
              onValueChange={(value) => update({ namespace: value ?? "all" })}
              value={search.namespace}
            >
              <SelectTrigger
                aria-label="Namespace"
                className="h-8 w-40 text-xs"
              >
                <SelectValue>
                  {search.namespace === "all"
                    ? "All namespaces"
                    : search.namespace}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All namespaces</SelectItem>
                {namespaces.map((namespace) => (
                  <SelectItem key={namespace} value={namespace}>
                    {namespace}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              aria-pressed={search.system}
              className="h-8 text-xs"
              onClick={() => update({ system: !search.system })}
              size="sm"
              variant={search.system ? "secondary" : "outline"}
            >
              System resources
            </Button>
          </>
        )}
        {search.mode === "services" && search.view === "infrastructure" && (
          <Button
            aria-pressed={search.problems}
            className="h-8 text-xs"
            onClick={() => update({ problems: !search.problems })}
            size="sm"
            variant={search.problems ? "secondary" : "outline"}
          >
            Problems only
          </Button>
        )}
        <div className="relative min-w-40 flex-1">
          <Search className="absolute top-2 left-2 size-4 text-muted-foreground" />
          <Input
            aria-label="Search resources"
            className="h-8 pl-8 text-xs"
            onChange={(event) => update({ q: event.target.value })}
            placeholder="Search name, kind, namespace…"
            value={search.q}
          />
        </div>
      </div>
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
function ResourceViews({
  search,
  views,
  inspect,
  update,
  referenceTime,
}: ResourcePageProps) {
  const common = { onInspect: inspect, referenceTime, views, search: search.q };
  if (search.view === "workloads") {
    const kinds: Record<string, string[]> = {
      workloads: ["Deployment", "StatefulSet", "DaemonSet"],
      pods: ["Pod"],
      services: ["Service"],
    };
    return (
      <Tabs
        onValueChange={(tab) => update({ tab: String(tab) })}
        value={kinds[search.tab] ? search.tab : "workloads"}
      >
        <TabsList>
          <TabsTrigger value="workloads">Workloads</TabsTrigger>
          <TabsTrigger value="pods">Pods</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
        </TabsList>
        {Object.entries(kinds).map(([tab, values]) => (
          <TabsContent className="mt-4" key={tab} value={tab}>
            <Resources
              {...common}
              kinds={values}
              namespace={search.namespace}
              showSystem={search.system}
            />
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
          namespace={search.namespace}
          onNamespace={(namespace) => update({ namespace })}
          problems={search.problems}
          showSystem={search.system}
        />
      </Suspense>
    );
  }
  if (search.mode === "servers") {
    return <Servers {...common} />;
  }
  return (
    <Resources
      {...common}
      namespace={search.namespace}
      showSystem={search.system}
    />
  );
}
