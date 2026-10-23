import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { CalendarClock, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchEvents,
  fetchSnapshot,
  fetchWorkspaces,
  useMonitoringStream,
} from "../hooks/api/clusters";
import { DisplayProvider, useDisplay } from "../hooks/display";
import { attentionItems, attentionSummary } from "../lib/attention";
import {
  backStep,
  inspectFrom,
  inspectState,
  panelRest,
} from "../lib/panel-history";
import { INVENTORY_RETENTION_DAYS } from "../lib/retention";
import { linkedOffer } from "../lib/share-link";
import {
  formatDateTime,
  type HubClock,
  hubNow,
  observationMs,
  timeZoneLabel,
} from "../lib/time";
import {
  type PanelTab,
  type SearchState,
  scopeReset,
  validateMonitorSearch,
} from "../schemas/monitor";
import { Architecture } from "./architecture";
import type { AttentionActions } from "./attention-list";
import { CommandPalette } from "./command-palette";
import {
  closePatch,
  clusterFilterPatch,
  clusterServersPatch,
  eventsEnabled,
  eventsKey,
  inspectPatch,
  linkedSettingsView,
  openClusterPatch,
  pagePatch,
  rangeOnlyChange,
  settingsLink,
  unreadableLinkTime,
  workspacePatch,
} from "./dashboard-navigation";
import { EnrollForm } from "./enroll-form";
import { EventsPage } from "./events-page";
import type { Crumb } from "./inspector-model";
import { NewWorkspace } from "./new-workspace";
import { Observability } from "./observability";
import { ObservationTime } from "./observation-time";
import { EmptyState, PageHeader } from "./page";
import { PageState, retrySnapshot } from "./page-state";
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
    // An unreadable link time is explained by the page, not sent.
    enabled: !unreadableLinkTime(search.at),
    refetchInterval: search.at ? false : refreshInterval,
    retry: retrySnapshot,
  });
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });
  const key = eventsKey(search);
  const events = useQuery({
    queryKey: key,
    queryFn: () => fetchEvents(search),
    enabled: eventsEnabled(search),
    staleTime: 25_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery && rangeOnlyChange(previousQuery.queryKey, key)
        ? previous
        : undefined,
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

type UpdateOptions =
  | boolean
  | { replace?: boolean; resetScroll?: boolean; state?: true | object };

// `true` alone means replace. A replace keeps the entry's history state, so
// the panel's Back marker survives tab, range and filter changes; a push
// starts a fresh entry unless it brings its own.
function navigationOptions(options: UpdateOptions = false) {
  const {
    replace = false,
    resetScroll,
    state,
  } = typeof options === "boolean" ? { replace: options } : options;
  return { replace, resetScroll, state: state ?? (replace || undefined) };
}

// The search the router is committing or showing, validated like the
// route's own.
function latestSearch(router: ReturnType<typeof useRouter>) {
  return validateMonitorSearch({ ...router.latestLocation.search });
}

function useDashboardNavigation(scope: string) {
  const navigate = useNavigate({ from: "/" });
  const router = useRouter();
  const update = useCallback(
    (next: Partial<SearchState>, options?: UpdateOptions) => {
      navigate({
        search: (old) => ({ ...old, ...next }),
        ...navigationOptions(options),
      });
    },
    [navigate]
  );
  const go = useCallback(
    (view: string, extra: Partial<SearchState> = {}) =>
      update(pagePatch(view, extra)),
    [update]
  );
  const openSettings = useCallback(
    (view: ClusterView, node?: Entity) =>
      go("settings", settingsLink(scope, view, node)),
    [go, scope]
  );
  // Opening a resource from an open one marks the new entry so Back can
  // follow history. The panel covers the page, so the page does not scroll.
  // Re-opening the resource on screen adds no entry.
  const inspect = useCallback(
    (view: ClusterView, entity: Entity, extra?: { panel?: PanelTab }) => {
      const current = latestSearch(router);
      if (
        current.resource === entity.uid &&
        current.resourceCluster === view.cluster.id
      ) {
        return;
      }
      update(inspectPatch(view, entity, extra), {
        state: inspectState(current),
        resetScroll: false,
      });
    },
    [router, update]
  );
  const closeInspector = useCallback(
    () => update(closePatch(), { resetScroll: false }),
    [update]
  );
  // A tab is a view of the same resource: it replaces the entry and keeps
  // the page behind the panel where it is.
  const onPanel = useCallback(
    (panel: PanelTab) =>
      update({ panel }, { replace: true, resetScroll: false }),
    [update]
  );
  const onBack = useBack(router, update);
  const openCluster = useCallback(
    (view: ClusterView) => update(openClusterPatch(view)),
    [update]
  );
  const openClusterServers = useCallback(
    (view: ClusterView) => update(clusterServersPatch(view)),
    [update]
  );
  const actions: AttentionActions = useMemo(
    () => ({ onInspect: inspect, onCluster: (view) => openSettings(view) }),
    [inspect, openSettings]
  );
  return {
    update,
    go,
    inspect,
    closeInspector,
    onPanel,
    onBack,
    openCluster,
    openClusterServers,
    openSettings,
    actions,
  };
}

// The panel's Back: the browser's Back when the previous entry is that
// resource on the same page (see panel-history), otherwise the resource in
// place. Clicks while that history step is underway are ignored.
function useBack(
  router: ReturnType<typeof useRouter>,
  update: (next: Partial<SearchState>, options?: UpdateOptions) => void
) {
  const pending = useRef(false);
  useEffect(
    () =>
      router.subscribe("onBeforeLoad", () => {
        pending.current = false;
      }),
    [router]
  );
  return useCallback(
    (crumb: Crumb) => {
      if (pending.current) {
        return;
      }
      const location = router.latestLocation;
      const step = backStep({
        marker: inspectFrom(location.state),
        crumbKey: crumb.key,
        canGoBack: router.history.canGoBack(),
        currentRest: panelRest(latestSearch(router)),
      });
      if (step === "history") {
        pending.current = true;
        router.history.back();
        return;
      }
      update(inspectPatch(crumb.view, crumb.entity), {
        replace: true,
        resetScroll: false,
      });
    },
    [router, update]
  );
}

// The page's main region takes focus once, when the control that opened a
// dialog is gone.
function focusMain() {
  const main = document.querySelector<HTMLElement>("main");
  if (main && !main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
    main.addEventListener("blur", () => main.removeAttribute("tabindex"), {
      once: true,
    });
  }
  return main;
}

// The saved-observation picker the page opens for a link time it could not
// read or the hub refused. Escape returns focus to the button that opened
// it; choosing a time replaces that button, so focus moves to the page.
// The button is passed in, because Safari and Firefox on macOS do not focus
// a button that is clicked.
function useTimeChooser() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const chosen = useRef(false);
  const show = useCallback((button?: HTMLElement) => {
    const active = document.activeElement;
    opener.current =
      button ??
      (active instanceof HTMLElement && active !== document.body
        ? active
        : null);
    chosen.current = false;
    setOpen(true);
  }, []);
  const choose = useCallback(() => {
    chosen.current = true;
  }, []);
  // `true` leaves it to Base UI: the element focused before it opened.
  const finalFocus = useCallback(() => {
    if (chosen.current) {
      return focusMain() ?? true;
    }
    return opener.current?.isConnected ? opener.current : true;
  }, []);
  return { open, setOpen, show, choose, finalFocus };
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
          linked={linkedSettingsView(
            data.views,
            data.allViews,
            search.settingsCluster
          )}
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

// A link time the page could not read, explained from the URL alone so the
// server and browser render the same markup. Nothing is asked of the hub.
function UnreadableTime({
  at,
  onChoose,
}: {
  at: string;
  onChoose: (button: HTMLElement) => void;
}) {
  const written = at.length > 40 ? `${at.slice(0, 40)}…` : at;
  return (
    // The actions row is centred to fit its content; below sm it stretches
    // so the button can take the phone's width.
    <EmptyState
      className="m-4 [&>div:last-child]:self-stretch sm:[&>div:last-child]:self-center"
      description={`Saved observation links carry a time with a zone, such as 2026-10-22T12:00:00Z. This link has “${written}”.`}
      icon={CalendarClock}
      title="Choose a saved observation time"
    >
      <Button
        className="w-full sm:w-auto"
        onClick={(event) => onChoose(event.currentTarget)}
      >
        Choose a time…
      </Button>
    </EmptyState>
  );
}

// The page under the project bar: the unreadable-time explanation, or the
// snapshot's state and the view itself.
function PageContent({
  search,
  data,
  loading,
  navigation,
  referenceTime,
  onConnect,
  onNewWorkspace,
  onChooseTime,
}: {
  search: SearchState;
  data: ReturnType<typeof useMonitorData>;
  loading: boolean;
  navigation: ReturnType<typeof useDashboardNavigation>;
  referenceTime: number;
  onConnect: () => void;
  onNewWorkspace: () => void;
  onChooseTime: (button?: HTMLElement) => void;
}) {
  const { snapshot } = data;
  if (unreadableLinkTime(search.at)) {
    return <UnreadableTime at={search.at ?? ""} onChoose={onChooseTime} />;
  }
  return (
    <>
      <PageState
        loading={loading}
        onChooseTime={onChooseTime}
        onRetry={() => snapshot.refetch()}
        snapshot={snapshot}
      />
      {!loading && (snapshot.data || !snapshot.isError) && (
        <PageBody
          data={data}
          navigation={navigation}
          onConnect={onConnect}
          onNewWorkspace={onNewWorkspace}
          referenceTime={referenceTime}
          search={search}
        />
      )}
    </>
  );
}

function PageActions({
  search,
  updating,
  connectDisabled,
  onRange,
  onConnect,
}: {
  search: SearchState;
  updating: boolean;
  connectDisabled: boolean;
  onRange: (range: string) => void;
  onConnect: () => void;
}) {
  return (
    <>
      {(search.view === "observability" || search.view === "activity") && (
        <>
          {/* The previous range's changes stay on screen while the new
              range loads, and this says so. */}
          <span className="text-muted-foreground text-xs" role="status">
            {updating ? "Updating…" : ""}
          </span>
          <RangeSelect onRange={onRange} range={search.range} />
        </>
      )}
      {search.view === "settings" && (
        <Button
          className="h-8"
          disabled={connectDisabled}
          onClick={onConnect}
          size="sm"
          variant="outline"
        >
          <Plus className="size-3.5" />
          Connect cluster
        </Button>
      )}
    </>
  );
}

function exactTime(time: number, timeZone: string) {
  return `${formatDateTime(time, timeZone)} ${timeZoneLabel(timeZone, time)}`;
}

// Absence is only claimed against a loaded snapshot; while the hub is
// unreachable the link stays in the URL and Retry reopens it. A live link
// remembers the time of the observation it was copied from, not when it
// was copied, and offers that saved observation.
function MissingResource({
  linkedAt,
  hubClock,
  onClose,
  onOpenSaved,
  onLive,
}: {
  linkedAt?: string;
  hubClock?: HubClock;
  onClose: () => void;
  onOpenSaved: (at: string) => void;
  onLive: () => void;
}) {
  const { now, frozen, timeZone } = useDisplay();
  const offer = frozen ? "none" : linkedOffer(linkedAt, hubNow(hubClock, now));
  const linked = observationMs(linkedAt);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
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
        {offer === "retained" && linked != null && (
          <p className="text-sm">
            {`This link remembers the observation at ${exactTime(linked, timeZone)}.`}
          </p>
        )}
        {offer === "expired" && (
          <p className="text-sm">
            This link's time is outside the {INVENTORY_RETENTION_DAYS}-day
            retention.
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
          {frozen && <Button onClick={onLive}>Return to live</Button>}
          {offer === "retained" && linked != null && linkedAt && (
            <Button onClick={() => onOpenSaved(linkedAt)}>
              Open as saved at {formatDateTime(linked, timeZone)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
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
  const chooser = useTimeChooser();
  const dashboardNavigation = useDashboardNavigation(scope);
  const { update, go, inspect, closeInspector, openSettings } =
    dashboardNavigation;
  const openPalette = useCallback(() => setPalette(true), []);
  // The canvas is the landing view: fetch its chunk alongside the snapshot
  // instead of after it.
  useEffect(() => {
    if (search.view === "architecture") {
      import("./topology").catch(() => undefined);
    }
  }, [search.view]);
  usePaletteShortcut(openPalette);
  const changeWorkspace = (workspace: string) =>
    update(workspacePatch(workspace));
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
  const hubClock = snapshot.data && {
    serverTime: snapshot.data.serverTime,
    receivedAt: snapshot.dataUpdatedAt,
  };
  const content = (
    <PageContent
      data={data}
      loading={loading}
      navigation={dashboardNavigation}
      onChooseTime={chooser.show}
      onConnect={() => setEnroll(true)}
      onNewWorkspace={() => setNewWorkspace(true)}
      referenceTime={referenceTime}
      search={search}
    />
  );
  return (
    <div className="flex min-h-svh flex-col">
      <ProjectBar
        attention={{ count: summary.actionable, worst: summary.worst }}
        cluster={search.cluster}
        clusters={allViews}
        connection={connection}
        onCluster={(cluster) => update(clusterFilterPatch(cluster))}
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
      {search.view === "architecture" ? (
        <main className="relative flex min-h-0 flex-1 flex-col outline-none">
          {content}
        </main>
      ) : (
        <main className="mx-auto w-full min-w-0 max-w-[1600px] space-y-6 p-4 outline-none md:p-6">
          <PageHeader
            actions={
              <PageActions
                connectDisabled={frozen || snapshot.isError}
                onConnect={() => setEnroll(true)}
                onRange={(range) => update({ range }, true)}
                search={search}
                updating={data.events.isPlaceholderData}
              />
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
          {content}
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
      <ObservationTime
        at={search.at}
        finalFocus={chooser.finalFocus}
        onOpenChange={chooser.setOpen}
        onSelect={(at) => {
          chooser.choose();
          update({ at });
        }}
        open={chooser.open}
        trigger={false}
      />
      <ResourceInspector
        at={search.at}
        connection={connection}
        hubClock={hubClock}
        inspected={inspected}
        onBack={dashboardNavigation.onBack}
        onClose={closeInspector}
        onCollection={openSettings}
        onInspect={inspect}
        onPanel={dashboardNavigation.onPanel}
        onRange={(range) =>
          update({ range }, { replace: true, resetScroll: false })
        }
        panel={search.panel}
        range={search.range}
        referenceTime={referenceTime}
        scope={search.workspace}
        search={search}
      />
      {search.resource && !inspected && snapshot.isSuccess && (
        <MissingResource
          hubClock={hubClock}
          linkedAt={search.linkedAt}
          onClose={closeInspector}
          onLive={() => update({ at: undefined })}
          onOpenSaved={(at) => update({ at, linkedAt: undefined })}
        />
      )}
    </div>
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
