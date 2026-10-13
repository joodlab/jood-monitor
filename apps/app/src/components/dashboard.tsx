import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import { Input } from "@jood-monitor/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@jood-monitor/ui/sidebar";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Activity,
  Bell,
  BookOpen,
  Boxes,
  CircleHelp,
  Clock3,
  LayoutGrid,
  Moon,
  Network,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";
import { EnrollForm } from "../components/enroll-form";
import { FleetOverview } from "../components/fleet-overview";
import { ObservationTime } from "../components/observation-time";
import { ProfileForm } from "../components/profile-form";
import { ResourceInspector } from "../components/resource-inspector";
import { Resources } from "../components/resources";
import { Servers } from "../components/servers";
import {
  fetchEvents,
  fetchSnapshot,
  fetchWorkspaces,
  useMonitoringStream,
} from "../hooks/api/clusters";
import { attentionItems, type ResourceItem } from "../lib/infrastructure";
import { freshness, observationTime } from "../lib/metrics";
import type { SearchState } from "../schemas/monitor";

const Topology = lazy(() =>
  import("./topology").then((module) => ({ default: module.Topology }))
);

const navigation = [
  { id: "overview", name: "Overview", icon: LayoutGrid },
  { id: "infrastructure", name: "Infrastructure", icon: Network },
  { id: "workloads", name: "Workloads", icon: Boxes },
  { id: "events", name: "Events & scaling", icon: Clock3 },
  { id: "attention", name: "Attention", icon: Bell },
  { id: "settings", name: "Settings", icon: Settings },
];

export function Dashboard() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const [enroll, setEnroll] = useState(false);
  const [now, setNow] = useState(0);
  const [theme, setTheme] = useState("dark");
  const scope = search.workspace;
  const snapshot = useQuery({
    queryKey: ["snapshot", scope, search.at ?? "live"],
    queryFn: () => fetchSnapshot(scope, search.at),
    refetchInterval: search.at ? false : 30_000,
  });
  const connection = useMonitoringStream(search, snapshot.data?.cursor);
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
    refetchInterval: search.at ? false : 30_000,
  });
  const allViews = snapshot.data?.clusters ?? [];
  const views = allViews.filter(
    (view) => !search.cluster || view.cluster.id === search.cluster
  );
  const referenceTime = observationTime(search.at, now);
  const inspectedView = allViews.find(
    (view) => view.cluster.id === search.resourceCluster
  );
  const inspectedEntity = inspectedView?.inventory.entities.find(
    (entity) => entity.uid === search.resource
  );
  const inspected =
    inspectedView && inspectedEntity
      ? { view: inspectedView, entity: inspectedEntity }
      : null;
  const attention = now
    ? attentionItems(views, referenceTime, !!search.at)
    : [];
  const namespaces = [
    ...new Set(
      views.flatMap((view) =>
        view.inventory.entities
          .map((entity) => entity.namespace)
          .filter((value): value is string => !!value)
      )
    ),
  ].sort();
  const workspaceName =
    scope === "global"
      ? "All workspaces"
      : (workspaces.data?.find((workspace) => workspace.id === scope)?.name ??
        scope);
  const pageName =
    navigation.find((item) => item.id === search.view)?.name ?? "Overview";
  const update = useCallback(
    (next: Partial<SearchState>) => {
      navigate({ search: (old) => ({ ...old, ...next }) });
    },
    [navigate]
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
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    try {
      const stored = localStorage.getItem("monitor-theme");
      if (stored === "light" || stored === "dark") {
        setTheme(stored);
      }
    } catch {
      /* Appearance remains usable. */
    }
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("monitor-theme", theme);
    } catch {
      /* optional */
    }
  }, [theme]);
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
  const snapshotText = observationLabel(search.at, snapshot.data?.serverTime);
  return (
    <SidebarProvider style={{ "--sidebar-width": "224px" } as CSSProperties}>
      <DashboardSidebar
        attentionCount={attention.length}
        changeWorkspace={changeWorkspace}
        scope={scope}
        search={search}
        setTheme={setTheme}
        theme={theme}
        update={update}
        workspaceName={workspaceName}
        workspaceOptions={workspaces.data ?? []}
      />
      <SidebarInset className="min-w-0">
        <DashboardHeader
          connection={connection}
          pageName={pageName}
          search={search}
          update={update}
          views={views}
        />
        <div className="min-w-0 space-y-5 p-4 md:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-semibold text-xl tracking-tight">
                {search.view === "overview" ? "Fleet overview" : pageName}
              </h1>
              <FleetCount
                available={!!snapshot.data}
                failed={snapshot.isError}
                views={views}
                workspaceName={workspaceName}
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-[10px] text-muted-foreground sm:block">
                {snapshotText} · Riyadh
              </span>
              <Button
                className="h-8 text-xs"
                disabled={!now || !!search.at || snapshot.isError}
                onClick={() => setEnroll(true)}
                size="sm"
                variant="outline"
              >
                <Plus className="size-3" />
                Connect cluster
              </Button>
            </div>
          </div>
          {snapshot.isError && (
            <div
              className="flex items-center justify-between rounded-lg border border-amber-500/30 p-4 text-sm"
              role="alert"
            >
              <span>Hub unavailable. Retained observations may be stale.</span>
              <Button
                onClick={() => snapshot.refetch()}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            </div>
          )}
          {search.at && (
            <p
              className="rounded-md border bg-muted/20 px-4 py-3 text-muted-foreground text-xs"
              role="status"
            >
              Saved inventory and metrics. Collection status and receipt
              metadata are not retained historically.
            </p>
          )}
          <FleetContent
            allViews={allViews}
            attention={attention}
            events={events}
            inspect={inspect}
            namespaces={namespaces}
            now={now}
            referenceTime={referenceTime}
            search={search}
            setEnroll={setEnroll}
            setTheme={setTheme}
            snapshot={snapshot}
            theme={theme}
            update={update}
            views={views}
          />
        </div>
      </SidebarInset>
      <Dialog onOpenChange={setEnroll} open={enroll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a cluster</DialogTitle>
            <DialogDescription>
              Create a scoped enrollment, install the released chart, and verify
              actual delivery.
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
        inspected={inspected}
        onClose={closeInspector}
        onCollection={(view, node) =>
          update({
            workspace: view.cluster.workspaceId,
            cluster: view.cluster.id,
            view: "settings",
            diagnosticNode: node?.uid,
            resource: undefined,
            resourceCluster: undefined,
          })
        }
        onInspect={inspect}
        range={search.range}
        referenceTime={referenceTime}
      />
      {search.resource && !inspected && !snapshot.isLoading && (
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
              <DialogTitle>Resource not observed</DialogTitle>
              <DialogDescription>
                This resource is absent from the selected snapshot. Historical
                coverage may be incomplete.
              </DialogDescription>
            </DialogHeader>
            <Button onClick={closeInspector} variant="outline">
              Return to infrastructure
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </SidebarProvider>
  );
}

function Navigation({
  view,
  onNavigate,
  attention,
}: {
  view: string;
  onNavigate: (view: string) => void;
  attention: number;
}) {
  const sidebar = useSidebar();
  return navigation.map((item) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton
        className="h-8 text-xs"
        isActive={view === item.id}
        onClick={() => {
          onNavigate(item.id);
          if (sidebar.isMobile) {
            sidebar.setOpenMobile(false);
          }
        }}
      >
        <item.icon className="size-4" />
        <span className="flex-1">{item.name}</span>
        {item.id === "attention" && attention > 0 && (
          <Badge className="h-4 px-1 text-[9px]" variant="secondary">
            {attention}
          </Badge>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  ));
}
function AttentionRow({
  item,
  onInspect,
}: {
  item: ResourceItem & { title: string; severity: string };
  onInspect: (view: ClusterView, entity: Entity) => void;
}) {
  return (
    <Button
      className="h-auto w-full justify-start gap-4 border p-4 text-left"
      onClick={() => onInspect(item.view, item.entity)}
      variant="ghost"
    >
      <Badge
        className={
          item.severity === "critical" ? "text-rose-500" : "text-amber-500"
        }
        variant="outline"
      >
        {item.severity}
      </Badge>
      <span className="min-w-0">
        <span className="block text-sm">{item.title}</span>
        <span className="block truncate font-mono text-muted-foreground text-xs">
          {item.entity.name}
        </span>
      </span>
    </Button>
  );
}
function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString("en", {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface ResourcePageProps {
  inspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  search: SearchState;
  update: (next: Partial<SearchState>) => void;
  views: ClusterView[];
}
function ResourceBrowser({
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

function CollectionSettings({
  search,
  views,
  referenceTime,
  theme,
  setTheme,
  onResumeLive,
}: {
  search: SearchState;
  views: ClusterView[];
  referenceTime: number;
  theme: string;
  setTheme: (value: string) => void;
  onResumeLive: () => void;
}) {
  if (search.at) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Collection status is current</CardTitle>
          <CardDescription>
            Saved observations retain inventory and metrics. Resume live to
            inspect collection acknowledgments and change profiles.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onResumeLive}>Resume live</Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <Tabs defaultValue="collection">
      <TabsList>
        <TabsTrigger value="collection">Collection</TabsTrigger>
        <TabsTrigger value="appearance">Appearance & capabilities</TabsTrigger>
      </TabsList>
      <TabsContent className="mt-4 space-y-4" value="collection">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              label: "Basic",
              detail:
                "Node resources every 60s. Inventory and pod status through API reconciliation.",
            },
            {
              label: "Standard",
              detail:
                "Node, pod and container CPU/memory every 30s when Metrics API is available. Host counters every 60s.",
            },
            {
              label: "Diagnostic",
              detail:
                "Selected host sources every 5s, bounded in time. Upstream pod Metrics API resolution stays unchanged.",
            },
          ].map((profile) => (
            <Card className="gap-2 py-4" key={profile.label}>
              <CardHeader className="px-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Radio className="size-4 text-primary" />
                  {profile.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 text-muted-foreground text-xs">
                {profile.detail}
              </CardContent>
            </Card>
          ))}
        </div>
        {views.map((view) => (
          <Card key={view.cluster.id}>
            <CardHeader>
              <CardTitle className="text-base">{view.cluster.name}</CardTitle>
              <CardDescription>
                Observer {view.heartbeat.version || "unknown"} ·{" "}
                {freshness(view.cluster.heartbeatAt, referenceTime)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  Buffer {view.heartbeat.queueBytes} B
                </Badge>
                <Badge variant="outline">
                  Dropped {view.heartbeat.dropped}
                </Badge>
                <Badge variant="outline">
                  Rejected {view.heartbeat.rejectedPoints}
                </Badge>
              </div>
              <ProfileForm
                frozen={!!search.at}
                initialNodeUid={search.diagnosticNode}
                key={`${view.cluster.id}:${view.profile.revision}:${search.diagnosticNode ?? ""}`}
                view={view}
              />
            </CardContent>
          </Card>
        ))}
      </TabsContent>
      <TabsContent className="mt-4 space-y-4" value="appearance">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Appearance</CardTitle>
            <CardDescription>Saved on this browser.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              variant="outline"
            >
              {theme === "dark" ? <Sun /> : <Moon />}Switch to{" "}
              {theme === "dark" ? "light" : "dark"}
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleHelp className="size-4" />
              Available sources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Kubernetes inventory, owner references, EndpointSlices, ingress
              routes and supported resource metrics.
            </p>
            <p className="text-muted-foreground">
              Service connections and HTTP request metrics require another
              measured source. Beyla and tracing are deferred.
            </p>
            {views.map((view) => (
              <p
                className="text-muted-foreground text-xs"
                key={view.cluster.id}
              >
                {view.cluster.name}:{" "}
                {view.heartbeat.capabilities?.join(" · ") ||
                  "Capabilities unknown"}
              </p>
            ))}
            <a
              className="inline-flex items-center gap-2 text-primary underline"
              href="/docs/metrics"
            >
              <BookOpen className="size-4" />
              Metrics and collection documentation
            </a>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function EventsPage({
  search,
  events,
}: {
  search: SearchState;
  events: UseQueryResult<Lifecycle[], Error>;
}) {
  const end = search.at ? Date.parse(search.at) : Date.now();
  const rows =
    events.data?.filter(
      (event) =>
        (!search.cluster || event.clusterId === search.cluster) &&
        Date.parse(event.observedAt) >= end - Number(search.range) * 3_600_000
    ) ?? [];
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Kubernetes changes and automation receipts · history starts at
        enrollment · latest 300 within selected interval · application logs
        unavailable
      </p>
      {events.isError && (
        <p role="alert">
          Event history unavailable.{" "}
          <Button onClick={() => events.refetch()} size="sm" variant="outline">
            Retry
          </Button>
        </p>
      )}
      {rows.map((event) => (
        <Card className="py-4" key={event.id}>
          <CardContent className="space-y-2 px-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium text-sm">
                {event.kind.replaceAll("_", " ")}
              </p>
              <time className="font-mono text-[10px] text-muted-foreground">
                {timeLabel(event.observedAt)}
              </time>
            </div>
            <p className="text-muted-foreground text-xs">
              {event.clusterId} · {event.attribution} attribution
            </p>
            <p className="break-words text-muted-foreground text-xs">
              {event.evidence}
            </p>
          </CardContent>
        </Card>
      ))}
      {!(events.isError || rows.length) && (
        <p className="rounded-lg border border-dashed p-12 text-center text-muted-foreground text-sm">
          No lifecycle evidence recorded in this scope.
        </p>
      )}
    </div>
  );
}

function DashboardHeader({
  search,
  views,
  pageName,
  connection,
  update,
}: {
  search: SearchState;
  views: ClusterView[];
  pageName: string;
  connection: string;
  update: (next: Partial<SearchState>) => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex min-h-13 flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="md:hidden" />
        <span className="text-muted-foreground text-xs">{pageName}</span>
        {search.cluster && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="truncate font-mono text-xs">
              {views[0]?.cluster.name || search.cluster}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Select
          onValueChange={(value) => update({ range: value ?? "1" })}
          value={search.range}
        >
          <SelectTrigger aria-label="Time range" className="h-7 w-27 text-xs">
            <SelectValue>{rangeLabels[search.range]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last hour</SelectItem>
            <SelectItem value="6">Last 6 hours</SelectItem>
            <SelectItem value="24">Last day</SelectItem>
          </SelectContent>
        </Select>
        <ObservationTime at={search.at} onSelect={(at) => update({ at })} />
        <Button
          aria-label={search.at ? "Resume live" : "Freeze observations"}
          className="h-7 gap-1.5 text-[11px]"
          onClick={() =>
            update({ at: search.at ? undefined : new Date().toISOString() })
          }
          size="sm"
          variant="outline"
        >
          {search.at ? (
            <Play className="size-3" />
          ) : (
            <Pause className="size-3" />
          )}
          <span
            className={`size-1.5 rounded-full ${connection === "connected" ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          {search.at
            ? "Frozen"
            : `Live · ${connection === "connected" ? views[0]?.profile.name || "ready" : connection}`}
        </Button>
      </div>
    </header>
  );
}

const rangeLabels: Record<string, string> = {
  "1": "Last hour",
  "6": "Last 6 hours",
  "24": "Last day",
};
function observationLabel(at?: string, observed?: string) {
  if (at) {
    return `Frozen ${timeLabel(at)}`;
  }
  return observed ? `Updated ${timeLabel(observed)}` : "Awaiting observations";
}

function DashboardSidebar({
  scope,
  workspaceName,
  workspaceOptions,
  changeWorkspace,
  search,
  update,
  attentionCount,
  theme,
  setTheme,
}: {
  scope: string;
  workspaceName: string;
  workspaceOptions: { id: string; name: string }[];
  changeWorkspace: (workspace: string) => void;
  search: SearchState;
  update: (next: Partial<SearchState>) => void;
  attentionCount: number;
  theme: string;
  setTheme: (theme: string) => void;
}) {
  return (
    <Sidebar>
      <SidebarHeader className="gap-4 px-3 py-4">
        <div className="flex items-center gap-2 px-2 font-medium text-sm">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Activity className="size-4" />
          </span>
          Jood Monitor
        </div>
        <Select
          onValueChange={(value) => changeWorkspace(value ?? "global")}
          value={scope}
        >
          <SelectTrigger aria-label="Workspace" className="h-11 w-full">
            <SelectValue>
              <span className="font-medium">{workspaceName}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="global">All workspaces</SelectItem>
            {workspaceOptions.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu className="px-2">
          <Navigation
            attention={attentionCount}
            onNavigate={(view) =>
              update({
                view,
                resource: undefined,
                resourceCluster: undefined,
                diagnosticNode: undefined,
              })
            }
            view={search.view}
          />
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="gap-3 border-t px-3 py-3">
        <a
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
          href="/docs"
        >
          <BookOpen className="size-4" />
          Documentation
        </a>
        <div className="flex items-center justify-between px-2">
          <div>
            <p className="font-medium text-xs">Ops team</p>
            <p className="text-[10px] text-muted-foreground">
              Private operator console
            </p>
          </div>
          <Button
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            size="icon-sm"
            variant="outline"
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function AttentionPage({
  attention,
  inspect,
}: {
  attention: ReturnType<typeof attentionItems>;
  inspect: (view: ClusterView, entity: Entity) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Current observed conditions. Historical restart counts do not establish
        an incident rate.
      </p>
      {attention.map((item) => (
        <AttentionRow
          item={item}
          key={`${item.entity.uid}:${item.title}`}
          onInspect={inspect}
        />
      ))}
      {!attention.length && (
        <p className="rounded-lg border border-dashed p-12 text-center text-muted-foreground text-sm">
          No observed readiness, pressure, or freshness problems.
        </p>
      )}
    </div>
  );
}

function FleetContent({
  search,
  views,
  allViews,
  referenceTime,
  inspect,
  update,
  attention,
  events,
  namespaces,
  snapshot,
  now,
  setEnroll,
  theme,
  setTheme,
}: ResourcePageProps & {
  allViews: ClusterView[];
  attention: ReturnType<typeof attentionItems>;
  events: UseQueryResult<Lifecycle[], Error>;
  namespaces: string[];
  snapshot: UseQueryResult<Awaited<ReturnType<typeof fetchSnapshot>>, Error>;
  now: number;
  setEnroll: (open: boolean) => void;
  theme: string;
  setTheme: (value: string) => void;
}) {
  if (snapshot.isError && !snapshot.data) {
    return null;
  }
  return (
    <>
      {" "}
      {snapshot.isLoading || !now ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((number) => (
            <Skeleton className="h-28" key={number} />
          ))}
        </div>
      ) : (
        <>
          {!allViews.length && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  No cluster connected
                </CardTitle>
                <CardDescription>
                  Install an observer and eligible node collectors to see this
                  workspace's real infrastructure.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  disabled={!!search.at}
                  onClick={() => setEnroll(true)}
                  size="sm"
                >
                  Create enrollment
                </Button>
                <a className="ml-4 text-sm underline" href="/docs/agents">
                  Installation guide
                </a>
              </CardContent>
            </Card>
          )}
          {search.view === "overview" && (
            <FleetOverview
              frozen={!!search.at}
              onCluster={(view) =>
                update({
                  workspace: view.cluster.workspaceId,
                  cluster: view.cluster.id,
                  view: "infrastructure",
                  mode: "services",
                  resource: undefined,
                  resourceCluster: undefined,
                })
              }
              onInspect={inspect}
              referenceTime={referenceTime}
              views={views}
            />
          )}
          {(search.view === "infrastructure" ||
            search.view === "workloads") && (
            <ResourceBrowser
              allViews={allViews}
              inspect={inspect}
              namespaces={namespaces}
              referenceTime={referenceTime}
              search={search}
              update={update}
              views={views}
            />
          )}
          {search.view === "attention" && (
            <AttentionPage attention={attention} inspect={inspect} />
          )}
          {search.view === "events" && (
            <EventsPage events={events} search={search} />
          )}
          {search.view === "settings" && (
            <CollectionSettings
              onResumeLive={() => update({ at: undefined })}
              referenceTime={referenceTime}
              search={search}
              setTheme={setTheme}
              theme={theme}
              views={views}
            />
          )}
        </>
      )}
    </>
  );
}

function FleetCount({
  views,
  workspaceName,
  available,
  failed,
}: {
  views: ClusterView[];
  workspaceName: string;
  available: boolean;
  failed: boolean;
}) {
  const nodes = views.reduce(
    (count, view) =>
      count +
      view.inventory.entities.filter((entity) => entity.kind === "Node").length,
    0
  );
  return (
    <p className="mt-1 text-muted-foreground text-xs">
      {available
        ? `${nodes} servers · ${views.length} clusters · ${workspaceName}`
        : `${failed ? "Inventory unavailable" : "Awaiting observations"} · ${workspaceName}`}
    </p>
  );
}
