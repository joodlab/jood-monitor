import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchEvents,
  fetchSnapshot,
  fetchWorkspaces,
  useMonitoringStream,
} from "../hooks/api/clusters";
import { DisplayProvider, useDisplay } from "../hooks/display";
import { attentionItems, attentionSummary } from "../lib/attention";
import { type SearchState, scopeReset } from "../schemas/monitor";
import { Architecture } from "./architecture";
import type { AttentionActions } from "./attention-list";
import { CommandPalette } from "./command-palette";
import { EnrollForm } from "./enroll-form";
import { EventsPage } from "./events-page";
import { NewWorkspace } from "./new-workspace";
import { Observability } from "./observability";
import { PageHeader } from "./page";
import { ProjectBar, projectTabs } from "./project-bar";
import { RangeSelect } from "./range-select";
import { ResourceBrowser } from "./resource-browser";
import { ResourceInspector } from "./resource-inspector";
import { CollectionSettings } from "./settings-page";
import { DataAge } from "./time";
import { WorkspacesPage } from "./workspaces-page";

const pageTitles: Record<string, string> = {
  observability: "Observability",
  resources: "Resources",
  activity: "Activity",
  settings: "Settings",
  workspaces: "Workspaces",
};
const pageDescriptions: Record<string, string> = {
  observability:
    "What needs attention, readiness and measured usage across the clusters in scope.",
  resources: "Servers, workloads, pods and services, with filters and search.",
  activity: "A timeline of what changed in the clusters in scope.",
  settings:
    "Observer health, collection profiles, diagnostics and cluster enrollment.",
  workspaces: "Workspaces group clusters and scope what you see.",
};

// Components written for the previous navigation still ask for its views;
// translate them to the project tabs.
function routeFor(view: string, extra: Partial<SearchState>) {
  if (view === "infrastructure") {
    if (extra.mode === "servers") {
      return { view: "resources", tab: "servers" };
    }
    return extra.mode === "list"
      ? { view: "resources", tab: "all" }
      : { view: "architecture" };
  }
  if (view === "workloads") {
    return { view: "resources", tab: extra.tab ?? "workloads" };
  }
  const legacy: Record<string, string> = {
    overview: "observability",
    attention: "observability",
    events: "activity",
  };
  return { view: legacy[view] ?? view };
}

export function Dashboard() {
  const search = useSearch({ from: "/" });
  return (
    <DisplayProvider at={search.at}>
      <DashboardContent />
    </DisplayProvider>
  );
}

function useMonitorData(search: SearchState) {
  const { now, referenceTime, frozen } = useDisplay();
  const scope = search.workspace;
  const connection = useMonitoringStream(search);
  const refreshInterval = connection === "connected" ? 120_000 : 30_000;
  const snapshot = useQuery({
    queryKey: ["snapshot", scope, search.at ?? "live"],
    queryFn: () => fetchSnapshot(scope, search.at),
    refetchInterval: search.at ? false : refreshInterval,
  });
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });
  const events = useQuery({
    queryKey: [
      "events",
      scope,
      search.at ?? "live",
      search.range,
      search.cluster,
    ],
    queryFn: () => fetchEvents(search),
    refetchInterval: search.at ? false : refreshInterval,
  });
  const allViews = useMemo(
    () => snapshot.data?.clusters ?? [],
    [snapshot.data]
  );
  const views = useMemo(
    () =>
      allViews.filter(
        (view) => !search.cluster || view.cluster.id === search.cluster
      ),
    [allViews, search.cluster]
  );
  const attention = useMemo(
    () => (now ? attentionItems(views, referenceTime, frozen) : []),
    [views, referenceTime, frozen, now]
  );
  const inspectedView = allViews.find(
    (view) => view.cluster.id === search.resourceCluster
  );
  const inspectedEntity = inspectedView?.inventory.entities.find(
    (entity) => entity.uid === search.resource
  );
  const namespaces = useMemo(
    () =>
      [
        ...new Set(
          views.flatMap((view) =>
            view.inventory.entities
              .map((entity) => entity.namespace)
              .filter((value): value is string => !!value)
          )
        ),
      ].sort(),
    [views]
  );
  const workspaceNames: Record<string, string> = Object.fromEntries(
    (workspaces.data ?? []).map((workspace) => [workspace.id, workspace.name])
  );
  return {
    connection,
    snapshot,
    workspaces,
    events,
    allViews,
    views,
    attention,
    namespaces,
    workspaceNames,
    workspaceName:
      scope === "global" ? "All workspaces" : (workspaceNames[scope] ?? scope),
    inspected:
      inspectedView && inspectedEntity
        ? { view: inspectedView, entity: inspectedEntity }
        : null,
  };
}

function useDashboardNavigation() {
  const navigate = useNavigate({ from: "/" });
  const update = useCallback(
    (next: Partial<SearchState>, replace = false) => {
      navigate({ search: (old) => ({ ...old, ...next }), replace });
    },
    [navigate]
  );
  const go = useCallback(
    (view: string, extra: Partial<SearchState> = {}) =>
      update({
        resource: undefined,
        resourceCluster: undefined,
        diagnosticNode: undefined,
        ...extra,
        ...routeFor(view, extra),
      }),
    [update]
  );
  const inspect = useCallback(
    (view: ClusterView, entity: Entity) =>
      update({ resource: entity.uid, resourceCluster: view.cluster.id }),
    [update]
  );
  const closeInspector = useCallback(
    () => update({ resource: undefined, resourceCluster: undefined }),
    [update]
  );
  const openCluster = useCallback(
    (view: ClusterView) =>
      go("architecture", {
        ...scopeReset,
        workspace: view.cluster.workspaceId,
        cluster: view.cluster.id,
      }),
    [go]
  );
  // The finder promises a cluster's servers.
  const openClusterServers = useCallback(
    (view: ClusterView) =>
      go("resources", {
        ...scopeReset,
        tab: "servers",
        workspace: view.cluster.workspaceId,
        cluster: view.cluster.id,
      }),
    [go]
  );
  const actions: AttentionActions = useMemo(
    () => ({
      onInspect: inspect,
      onCluster: (view) =>
        go("settings", {
          workspace: view.cluster.workspaceId,
          cluster: view.cluster.id,
        }),
    }),
    [inspect, go]
  );
  return {
    update,
    go,
    inspect,
    closeInspector,
    openCluster,
    openClusterServers,
    actions,
  };
}

// ⌘K / Ctrl+K opens the finder. There is no single-key shortcut, so speech
// and switch input cannot open it by accident (WCAG 2.1.4).
function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        open();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
}

function PageBody({
  search,
  data,
  navigation: { update, go, inspect, openCluster, actions },
  referenceTime,
  onConnect,
  onNewWorkspace,
}: {
  search: SearchState;
  data: ReturnType<typeof useMonitorData>;
  navigation: ReturnType<typeof useDashboardNavigation>;
  referenceTime: number;
  onConnect: () => void;
  onNewWorkspace: () => void;
}) {
  switch (search.view) {
    case "architecture":
      return (
        <Architecture
          actions={actions}
          allViews={data.allViews}
          attention={data.attention}
          events={data.events}
          inspect={inspect}
          namespaces={data.namespaces}
          onConnect={onConnect}
          onNavigate={(view, extra) => go(view, extra)}
          referenceTime={referenceTime}
          search={search}
          update={update}
          views={data.views}
        />
      );
    case "resources":
      return (
        <ResourceBrowser
          inspect={inspect}
          namespaces={data.namespaces}
          referenceTime={referenceTime}
          search={search}
          update={update}
          views={data.views}
        />
      );
    case "activity":
      return (
        <EventsPage
          events={data.events}
          onInspect={inspect}
          onRange={(range) => update({ range }, true)}
          range={search.range}
          views={data.allViews}
        />
      );
    case "settings":
      return (
        <CollectionSettings
          onResumeLive={() => update({ at: undefined })}
          search={search}
          views={data.views}
        />
      );
    case "workspaces":
      return (
        <WorkspacesPage
          error={data.workspaces.isError && !data.workspaces.data}
          loading={data.workspaces.isPending}
          onNewWorkspace={onNewWorkspace}
          onOpen={(workspace) =>
            go("architecture", { ...scopeReset, workspace, cluster: undefined })
          }
          onRetry={() => data.workspaces.refetch()}
          scope={search.workspace}
          views={data.allViews}
          workspaces={data.workspaces.data ?? []}
        />
      );
    default:
      return (
        <Observability
          actions={actions}
          attention={data.attention}
          clusterFilter={search.cluster}
          events={data.events}
          onCluster={openCluster}
          onConnect={onConnect}
          onNavigate={(view, extra) => go(view, extra)}
          views={data.views}
          workspaceNames={data.workspaceNames}
        />
      );
  }
}

function DashboardContent() {
  const search = useSearch({ from: "/" });
  const { now, referenceTime, frozen } = useDisplay();
  const [enroll, setEnroll] = useState(false);
  const [palette, setPalette] = useState(false);
  const scope = search.workspace;
  const data = useMonitorData(search);
  const {
    connection,
    snapshot,
    workspaces,
    allViews,
    views,
    attention,
    workspaceName,
    inspected,
  } = data;
  const summary = attentionSummary(attention);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const dashboardNavigation = useDashboardNavigation();
  const { update, go, inspect, closeInspector } = dashboardNavigation;
  const openPalette = useCallback(() => setPalette(true), []);
  // The canvas is the landing view: fetch its chunk alongside the snapshot
  // instead of after it.
  useEffect(() => {
    if (search.view === "architecture") {
      import("./topology").catch(() => undefined);
    }
  }, [search.view]);
  usePaletteShortcut(openPalette);
  function changeWorkspace(workspace: string) {
    update({
      ...scopeReset,
      workspace,
      cluster: undefined,
      resource: undefined,
      resourceCluster: undefined,
      diagnosticNode: undefined,
    });
  }
  const pageTargets = useMemo(
    () =>
      [...projectTabs, { id: "workspaces", name: "Workspaces" }].map(
        (item) => ({
          id: item.id,
          label: item.name,
          run: () => go(item.id),
        })
      ),
    [go]
  );
  const loading = snapshot.isLoading || !now;
  const counts = countSummary(views, !!snapshot.data, workspaceName);
  const canvas = search.view === "architecture";
  const state = (
    <PageState
      loading={loading}
      onRetry={() => snapshot.refetch()}
      snapshot={snapshot}
    />
  );
  return (
    <div className="flex min-h-svh flex-col">
      <ProjectBar
        attention={{ count: summary.actionable, worst: summary.worst }}
        cluster={search.cluster}
        clusters={allViews}
        connection={connection}
        onCluster={(cluster) => update({ ...scopeReset, cluster })}
        onFreeze={(at) => update({ at })}
        onNavigate={(view) => go(view)}
        onNewWorkspace={() => setNewWorkspace(true)}
        onSearch={() => setPalette(true)}
        onWorkspace={changeWorkspace}
        view={search.view}
        workspace={scope}
        workspaceName={workspaceName}
        workspaces={workspaces.data ?? []}
      />
      {canvas ? (
        <main className="relative flex min-h-0 flex-1 flex-col">
          {state}
          {!loading && (snapshot.data || !snapshot.isError) && (
            <PageBody
              data={data}
              navigation={dashboardNavigation}
              onConnect={() => setEnroll(true)}
              onNewWorkspace={() => setNewWorkspace(true)}
              referenceTime={referenceTime}
              search={search}
            />
          )}
        </main>
      ) : (
        <main className="mx-auto w-full min-w-0 max-w-[1600px] space-y-6 p-4 md:p-6">
          <PageHeader
            actions={
              <>
                {(search.view === "observability" ||
                  search.view === "activity") && (
                  <RangeSelect
                    onRange={(range) => update({ range }, true)}
                    range={search.range}
                  />
                )}
                {search.view === "settings" && (
                  <Button
                    className="h-8"
                    disabled={frozen || snapshot.isError}
                    onClick={() => setEnroll(true)}
                    size="sm"
                    variant="outline"
                  >
                    <Plus className="size-3.5" />
                    Connect cluster
                  </Button>
                )}
              </>
            }
            description={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{pageDescriptions[search.view]}</span>
                <span className="text-xs">{counts}</span>
                {snapshot.data && <DataAge views={views} />}
              </span>
            }
            title={pageTitles[search.view] ?? "Observability"}
          />
          {state}
          {!loading && (snapshot.data || !snapshot.isError) && (
            <PageBody
              data={data}
              navigation={dashboardNavigation}
              onConnect={() => setEnroll(true)}
              onNewWorkspace={() => setNewWorkspace(true)}
              referenceTime={referenceTime}
              search={search}
            />
          )}
        </main>
      )}
      <Dialog onOpenChange={setNewWorkspace} open={newWorkspace}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Workspaces group clusters and scope what the dashboard shows.
            </DialogDescription>
          </DialogHeader>
          <NewWorkspace
            onCancel={() => setNewWorkspace(false)}
            onCreated={(workspace) => {
              setNewWorkspace(false);
              changeWorkspace(workspace.id);
            }}
          />
        </DialogContent>
      </Dialog>
      <CommandPalette
        onCluster={dashboardNavigation.openClusterServers}
        onInspect={inspect}
        onOpenChange={setPalette}
        open={palette}
        pages={pageTargets}
        views={allViews}
      />
      <Dialog onOpenChange={setEnroll} open={enroll}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connect a cluster</DialogTitle>
            <DialogDescription>
              Create a scoped enrollment, install the observer, and confirm the
              first delivery.
            </DialogDescription>
          </DialogHeader>
          <EnrollForm
            clusters={allViews.map((view) => view.cluster)}
            workspace={scope}
          />
        </DialogContent>
      </Dialog>
      <ResourceInspector
        at={search.at}
        connection={connection}
        inspected={inspected}
        onClose={closeInspector}
        onCollection={(view, node) =>
          go("settings", {
            workspace: view.cluster.workspaceId,
            cluster: view.cluster.id,
            diagnosticNode: node?.uid,
          })
        }
        onInspect={inspect}
        onRange={(range) => update({ range }, true)}
        range={search.range}
        referenceTime={referenceTime}
        scope={search.workspace}
      />
      {/* Absence is only claimed against a loaded snapshot; while the hub is
          unreachable the link stays in the URL and Retry reopens it. */}
      {search.resource && !inspected && snapshot.isSuccess && (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              closeInspector();
            }
          }}
          open
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Resource not in this observation</DialogTitle>
              <DialogDescription>
                The linked resource is absent from the selected snapshot. It may
                have been deleted or replaced, or historical coverage may be
                incomplete.
              </DialogDescription>
            </DialogHeader>
            <Button onClick={closeInspector} variant="outline">
              Close
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function PageState({
  snapshot,
  loading,
  onRetry,
}: {
  snapshot: { isError: boolean };
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      {snapshot.isError && (
        <div
          className="m-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm"
          role="alert"
        >
          <span>
            The hub could not be reached. Observations below may be out of date.
          </span>
          <Button onClick={onRetry} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      )}
      {loading && !snapshot.isError && (
        <div aria-busy="true" className="space-y-4 p-4">
          <span className="sr-only" role="status">
            Loading observations…
          </span>
          <Skeleton className="h-28" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[1, 2, 3, 4].map((item) => (
              <Skeleton className="h-24" key={item} />
            ))}
          </div>
          <Skeleton className="h-40" />
        </div>
      )}
    </>
  );
}

function countSummary(
  views: ClusterView[],
  available: boolean,
  workspaceName: string
) {
  if (!available) {
    return workspaceName;
  }
  const nodes = views.reduce(
    (count, view) =>
      count +
      view.inventory.entities.filter((entity) => entity.kind === "Node").length,
    0
  );
  return `${views.length} cluster${views.length === 1 ? "" : "s"} · ${nodes} server${nodes === 1 ? "" : "s"} · ${workspaceName}`;
}
