import type { ClusterView } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@jood-monitor/ui/dropdown-menu";
import { cn } from "@jood-monitor/ui/utils";
import {
  Activity,
  BookOpen,
  CalendarClock,
  ChevronsUpDown,
  Moon,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Sun,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useDisplay } from "../hooks/display";
import type { Severity } from "../lib/attention";
import { freshness } from "../lib/metrics";
import {
  formatDateTime,
  type TimeZonePreference,
  timeZoneLabel,
  timeZoneOptions,
} from "../lib/time";
import { ObservationTime } from "./observation-time";

// Railway-style project bar: logo / workspace / cluster on the left, project
// tabs on the right. Workspaces play Railway's "project" role and clusters
// its "environment" role.

export interface ProjectTab {
  id: string;
  name: string;
}

export const projectTabs: ProjectTab[] = [
  { id: "architecture", name: "Architecture" },
  { id: "observability", name: "Observability" },
  { id: "resources", name: "Resources" },
  { id: "activity", name: "Activity" },
  { id: "settings", name: "Settings" },
];

const zoneNames: Record<TimeZonePreference, string> = {
  local: "Browser time",
  UTC: "UTC",
  "Asia/Riyadh": "Riyadh",
};

const badgeTone: Record<Severity, string> = {
  critical: "bg-destructive/15 text-destructive-text",
  warning: "bg-warning/20 text-warning-text",
  info: "bg-info/15 text-info-text",
};

function Crumb({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label}: ${value}`}
        className="flex min-w-0 max-w-[38vw] items-center gap-1.5 rounded-md px-1.5 py-1.5 font-medium text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted sm:max-w-52 sm:px-2"
      >
        <span className="truncate">{value}</span>
        <ChevronsUpDown
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

// Heartbeat state in words, so it never depends on the dot's colour.
function heartbeatState(view: ClusterView, now: number) {
  if (!view.cluster.heartbeatAt) {
    return "no heartbeat yet";
  }
  return freshness(view.cluster.heartbeatAt, now) === "fresh"
    ? "heartbeat fresh"
    : "heartbeat stale";
}

function clusterDot(view: ClusterView, now: number) {
  if (!view.cluster.heartbeatAt) {
    return "bg-muted-foreground";
  }
  return freshness(view.cluster.heartbeatAt, now) === "fresh"
    ? "bg-success"
    : "bg-warning";
}

function PreferencesMenu({ onTimeTravel }: { onTimeTravel: () => void }) {
  const display = useDisplay();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Display preferences and help"
        className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted"
      >
        <Settings2 className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() =>
              display.setTheme(display.theme === "dark" ? "light" : "dark")
            }
          >
            {display.theme === "dark" ? <Sun /> : <Moon />}
            Switch to {display.theme === "dark" ? "light" : "dark"} theme
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            Time zone · {timeZoneLabel(display.timeZone)}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) =>
              display.setTimeZonePreference(value as TimeZonePreference)
            }
            value={display.timeZonePreference}
          >
            {timeZoneOptions.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {zoneNames[option]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="sm:hidden" onClick={onTimeTravel}>
          <CalendarClock />
          View a saved observation…
        </DropdownMenuItem>
        {/* biome-ignore lint/a11y/useAnchorContent: the menu item children render inside the link. */}
        <DropdownMenuItem render={<a href="/docs" />}>
          <BookOpen />
          Documentation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LiveControl({
  connection,
  onFreeze,
  timeTravel,
  onTimeTravel,
}: {
  connection: string;
  onFreeze: (at?: string) => void;
  timeTravel: boolean;
  onTimeTravel: (open: boolean) => void;
}) {
  const { frozen, at } = useDisplay();
  const connected = connection === "connected";
  return (
    <div className="flex items-center gap-1">
      {/* Rendered at every width so state changes are announced. */}
      <button
        aria-label={
          frozen ? "Resume live updates" : "Freeze at the current time"
        }
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          frozen && "border-info/40 text-info-text",
          !(frozen || connected) && "border-warning/40 text-warning-text"
        )}
        onClick={() => onFreeze(frozen ? undefined : new Date().toISOString())}
        type="button"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            frozen && "bg-info",
            !frozen && connected && "bg-success",
            !(frozen || connected) && "bg-warning"
          )}
        />
        {/* Phones show only the dot while live; text appears whenever the
            stream is reconnecting or the view is frozen. */}
        <span
          className={cn(!frozen && connected && "sr-only sm:not-sr-only")}
          role="status"
        >
          {frozen && "Frozen"}
          {!frozen && (connected ? "Live" : "Reconnecting…")}
        </span>
        {frozen ? (
          <Play aria-hidden className="size-3" />
        ) : (
          <Pause aria-hidden className="size-3 text-muted-foreground" />
        )}
      </button>
      <ObservationTime
        at={at}
        onOpenChange={onTimeTravel}
        onSelect={(value) => onFreeze(value)}
        open={timeTravel}
        triggerClassName="hidden sm:inline-flex"
      />
    </div>
  );
}

export function ProjectBar({
  view,
  workspace,
  workspaceName,
  workspaces,
  cluster,
  clusters,
  attention,
  connection,
  onNavigate,
  onWorkspace,
  onCluster,
  onNewWorkspace,
  onFreeze,
  onSearch,
}: {
  view: string;
  workspace: string;
  workspaceName: string;
  workspaces: { id: string; name: string }[];
  cluster?: string;
  clusters: ClusterView[];
  attention: { count: number; worst?: Severity };
  connection: string;
  onNavigate: (view: string) => void;
  onWorkspace: (workspace: string) => void;
  onCluster: (cluster?: string) => void;
  onNewWorkspace: () => void;
  onFreeze: (at?: string) => void;
  onSearch: () => void;
}) {
  const { now, frozen, at, timeZone } = useDisplay();
  const [timeTravel, setTimeTravel] = useState(false);
  const clusterName = cluster
    ? (clusters.find((item) => item.cluster.id === cluster)?.cluster.name ??
      cluster)
    : "All clusters";
  return (
    <header
      className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur"
      data-project-bar
    >
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-3 sm:px-4">
        <nav
          aria-label="Workspace and cluster"
          className="flex min-w-0 flex-1 items-center gap-1 text-sm"
        >
          <button
            aria-label="All workspaces"
            className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onNavigate("workspaces")}
            title="Workspaces"
            type="button"
          >
            <Activity className="size-4" />
          </button>
          <span aria-hidden className="text-muted-foreground/60">
            /
          </span>
          <Crumb label="Workspace" value={workspaceName}>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={(value) => onWorkspace(String(value))}
                value={workspace}
              >
                <DropdownMenuRadioItem closeOnClick value="global">
                  All workspaces
                </DropdownMenuRadioItem>
                {workspaces.map((item) => (
                  <DropdownMenuRadioItem
                    closeOnClick
                    key={item.id}
                    value={item.id}
                  >
                    <span className="truncate">{item.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onNewWorkspace}>
              <Plus />
              New workspace
            </DropdownMenuItem>
          </Crumb>
          <span aria-hidden className="text-muted-foreground/60">
            /
          </span>
          <Crumb label="Cluster" value={clusterName}>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Clusters</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={(value) =>
                  onCluster(value === "all" ? undefined : String(value))
                }
                value={cluster ?? "all"}
              >
                <DropdownMenuRadioItem closeOnClick value="all">
                  All clusters
                </DropdownMenuRadioItem>
                {clusters.map((item) => (
                  <DropdownMenuRadioItem
                    closeOnClick
                    key={item.cluster.id}
                    value={item.cluster.id}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        clusterDot(item, now)
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {item.cluster.name}
                      </span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {item.cluster.environment} · {heartbeatState(item, now)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </Crumb>
        </nav>
        <div className="flex items-center gap-1">
          <Button
            aria-keyshortcuts="Control+K Meta+K"
            aria-label="Find a page or resource"
            className="h-8 gap-2 px-2 text-muted-foreground"
            onClick={onSearch}
            variant="ghost"
          >
            <Search className="size-4" />
            <kbd
              aria-hidden
              className="hidden rounded border px-1 text-xs lg:inline"
            >
              Ctrl/⌘ K
            </kbd>
          </Button>
          <LiveControl
            connection={connection}
            onFreeze={onFreeze}
            onTimeTravel={setTimeTravel}
            timeTravel={timeTravel}
          />
          <PreferencesMenu onTimeTravel={() => setTimeTravel(true)} />
        </div>
      </div>
      <nav
        aria-label="Project"
        className="-mb-px flex gap-1 overflow-x-auto px-3 sm:px-4"
      >
        {projectTabs.map((tab) => {
          const active = view === tab.id;
          return (
            <button
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-10 shrink-0 items-center gap-1.5 px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                active
                  ? "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
              key={tab.id}
              onClick={() => onNavigate(tab.id)}
              type="button"
            >
              {tab.name}
              {tab.id === "observability" &&
                attention.count > 0 &&
                attention.worst && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 font-medium text-xs tabular-nums",
                      badgeTone[attention.worst]
                    )}
                  >
                    <span className="sr-only">
                      {attention.count} problems need attention
                    </span>
                    <span aria-hidden>{attention.count}</span>
                  </span>
                )}
            </button>
          );
        })}
      </nav>
      {frozen && at && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-info/30 border-t bg-info/10 px-4 py-2 text-xs"
          role="status"
        >
          <span>
            Viewing the saved observation at{" "}
            <strong className="font-medium">
              {formatDateTime(at, timeZone)}{" "}
              {timeZoneLabel(timeZone, Date.parse(at))}
            </strong>
            . Live updates are paused; collection status is not retained
            historically.
          </span>
          <Button
            className="h-9 text-xs sm:h-8"
            onClick={() => onFreeze(undefined)}
            size="sm"
            variant="outline"
          >
            Return to live
          </Button>
        </div>
      )}
    </header>
  );
}
