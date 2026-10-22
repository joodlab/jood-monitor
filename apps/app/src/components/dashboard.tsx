import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import { SidebarInset, SidebarProvider } from "@jood-monitor/ui/sidebar";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  fetchEvents,
  fetchSnapshot,
  fetchWorkspaces,
  useMonitoringStream,
} from "../hooks/api/clusters";
import { DisplayProvider, useDisplay } from "../hooks/display";
import { attentionItems, attentionSummary } from "../lib/attention";
import type { SearchState } from "../schemas/monitor";
import { AppHeader, AppSidebar, navigation } from "./app-shell";
import type { AttentionActions } from "./attention-list";
import { AttentionPage } from "./attention-page";
import { CommandPalette } from "./command-palette";
import { EnrollForm } from "./enroll-form";
import { EventsPage } from "./events-page";
import { FleetOverview } from "./fleet-overview";
import { PageHeader } from "./page";
import { ResourceBrowser } from "./resource-browser";
import { ResourceInspector } from "./resource-inspector";
import { CollectionSettings } from "./settings-page";
import { DataAge } from "./time";

const pageDescriptions: Record<string, string> = {
  infrastructure:
    "Discovered structure, servers and every observed resource. Topology shows configuration, not traffic.",
  workloads: "Deployments, StatefulSets, DaemonSets, pods and services.",
  settings:
    "Observer health, collection profiles, diagnostics and cluster enrollment.",
};

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
        view,
        resource: undefined,
        resourceCluster: undefined,
        diagnosticNode: undefined,
        ...extra,
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
      go("infrastructure", {
        workspace: view.cluster.workspaceId,
        cluster: view.cluster.id,
        mode: "servers",
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
  return { update, go, inspect, closeInspector, openCluster, actions };
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
}: {
  search: SearchState;
  data: ReturnType<typeof useMonitorData>;
  navigation: ReturnType<typeof useDashboardNavigation>;
  referenceTime: number;
  onConnect: () => void;
}) {
  switch (search.view) {
    case "attention":
      return (
        <AttentionPage
          actions={actions}
          attention={data.attention}
          clusterFilter={search.cluster}
          views={data.views}
        />
      );
    case "infrastructure":
    case "workloads":
      return (
        <ResourceBrowser
          allViews={data.allViews}
          inspect={inspect}
          namespaces={data.namespaces}
          referenceTime={referenceTime}
          search={search}
          update={update}
          views={data.views}
        />
      );
    case "events":
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
    default:
      return (
        <FleetOverview
          actions={actions}
          attention={data.attention}
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
  const page = navigation.find((item) => item.id === search.view);
  const dashboardNavigation = useDashboardNavigation();
  const { update, go, inspect, closeInspector, openCluster } =
    dashboardNavigation;
  const openPalette = useCallback(() => setPalette(true), []);
  usePaletteShortcut(openPalette);
  function changeWorkspace(workspace: string) {
    update({
      workspace,
      cluster: undefined,
      namespace: "all",
      q: "",
      resource: undefined,
      resourceCluster: undefined,
      diagnosticNode: undefined,
    });
  }
  const pageTargets = useMemo(
    () =>
      navigation.map((item) => ({
        id: item.id,
        label: item.name,
        run: () => go(item.id),
      })),
    [go]
  );
  const loading = snapshot.isLoading || !now;
  const counts = countSummary(views, !!snapshot.data, workspaceName);
  return (
    <SidebarProvider style={{ "--sidebar-width": "240px" } as CSSProperties}>
      <AppSidebar
        attention={{ count: summary.actionable, worst: summary.worst }}
        onNavigate={(view) => go(view)}
        onSearch={() => setPalette(true)}
        onWorkspace={changeWorkspace}
        view={search.view}
        workspace={scope}
        workspaceName={workspaceName}
        workspaces={workspaces.data ?? []}
      />
      <SidebarInset className="min-w-0">
        <AppHeader
          clusterName={
            search.cluster
              ? (allViews.find((view) => view.cluster.id === search.cluster)
                  ?.cluster.name ?? search.cluster)
              : undefined
          }
          connection={connection}
          onClearCluster={() =>
            update({ cluster: undefined, namespace: "all" })
          }
          onFreeze={(at) => update({ at })}
          onRange={(range) => update({ range }, true)}
          onSearch={() => setPalette(true)}
          page={page?.name ?? "Overview"}
          range={search.range}
        />
        <main className="min-w-0 space-y-5 p-4 md:p-6">
          <PageHeader
            actions={
              (search.view === "overview" || search.view === "settings") && (
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
              )
            }
            description={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{pageDescriptions[search.view] ?? counts}</span>
                {pageDescriptions[search.view] && (
                  <span className="text-xs">{counts}</span>
                )}
                {snapshot.data && <DataAge views={views} />}
              </span>
            }
            title={page?.name ?? "Overview"}
          />
          {snapshot.isError && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm"
              role="alert"
            >
              <span>
                The hub could not be reached. Observations below may be out of
                date.
              </span>
              <Button
                onClick={() => snapshot.refetch()}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            </div>
          )}
          {loading && !snapshot.isError && (
            <div aria-busy="true" className="space-y-4">
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
          {!loading && (snapshot.data || !snapshot.isError) && (
            <PageBody
              data={data}
              navigation={dashboardNavigation}
              onConnect={() => setEnroll(true)}
              referenceTime={referenceTime}
              search={search}
            />
          )}
        </main>
      </SidebarInset>
      <CommandPalette
        onCluster={openCluster}
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
        range={search.range}
        referenceTime={referenceTime}
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
    </SidebarProvider>
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
