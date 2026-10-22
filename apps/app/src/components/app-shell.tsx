import { Button } from "@jood-monitor/ui/button";
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@jood-monitor/ui/sidebar";
import { cn } from "@jood-monitor/ui/utils";
import {
  Activity,
  Bell,
  BookOpen,
  Boxes,
  Clock3,
  History,
  LayoutGrid,
  type LucideIcon,
  Moon,
  Network,
  Pause,
  Play,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useDisplay } from "../hooks/display";
import type { Severity } from "../lib/attention";
import {
  formatDateTime,
  type TimeZonePreference,
  timeZoneLabel,
  timeZoneOptions,
} from "../lib/time";
import { ObservationTime } from "./observation-time";

export interface NavigationItem {
  icon: LucideIcon;
  id: string;
  name: string;
}

export const navigation: NavigationItem[] = [
  { id: "overview", name: "Overview", icon: LayoutGrid },
  { id: "attention", name: "Attention", icon: Bell },
  { id: "infrastructure", name: "Infrastructure", icon: Network },
  { id: "workloads", name: "Workloads", icon: Boxes },
  { id: "events", name: "Events & scaling", icon: Clock3 },
  { id: "settings", name: "Clusters & collection", icon: Settings },
];

const badgeTone: Record<Severity, string> = {
  critical: "bg-destructive/15 text-destructive-text",
  warning: "bg-warning/20 text-warning-text",
  info: "bg-info/15 text-info-text",
};

function NavigationMenu({
  view,
  onNavigate,
  attention,
}: {
  view: string;
  onNavigate: (view: string) => void;
  attention: { count: number; worst?: Severity };
}) {
  const sidebar = useSidebar();
  return navigation.map((item) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton
        aria-current={view === item.id ? "page" : undefined}
        className="h-9 text-sm"
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
        {item.id === "attention" && attention.count > 0 && attention.worst && (
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
      </SidebarMenuButton>
    </SidebarMenuItem>
  ));
}

const zoneNames: Record<TimeZonePreference, string> = {
  local: "Browser time",
  UTC: "UTC",
  "Asia/Riyadh": "Riyadh",
};

export function AppSidebar({
  view,
  workspace,
  workspaceName,
  workspaces,
  attention,
  onNavigate,
  onWorkspace,
  onSearch,
}: {
  view: string;
  workspace: string;
  workspaceName: string;
  workspaces: { id: string; name: string }[];
  attention: { count: number; worst?: Severity };
  onNavigate: (view: string) => void;
  onWorkspace: (workspace: string) => void;
  onSearch: () => void;
}) {
  const display = useDisplay();
  return (
    <Sidebar>
      <SidebarHeader className="gap-3 px-3 py-4">
        <div className="flex items-center gap-2 px-2 font-semibold text-sm">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Activity className="size-4" />
          </span>
          Jood Monitor
        </div>
        <div className="space-y-1">
          <p
            className="px-1 text-muted-foreground text-xs"
            id="workspace-label"
          >
            Workspace
          </p>
          <Select
            onValueChange={(value) => onWorkspace(value ?? "global")}
            value={workspace}
          >
            <SelectTrigger
              aria-labelledby="workspace-label"
              className="h-10 w-full"
            >
              <SelectValue>
                <span className="truncate font-medium">{workspaceName}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">All workspaces</SelectItem>
              {workspaces.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          aria-keyshortcuts="Control+K Meta+K"
          className="h-9 justify-start gap-2 text-muted-foreground"
          onClick={onSearch}
          variant="outline"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Find resource</span>
          <kbd aria-hidden className="rounded border px-1 text-xs">
            Ctrl/⌘ K
          </kbd>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu className="px-2">
          <NavigationMenu
            attention={attention}
            onNavigate={onNavigate}
            view={view}
          />
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="gap-2 border-t px-3 py-3">
        <a
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-sm hover:bg-muted hover:text-foreground"
          href="/docs"
        >
          <BookOpen className="size-4" />
          Documentation
        </a>
        <div className="flex items-center gap-2 px-1">
          <Select
            onValueChange={(value) =>
              display.setTimeZonePreference(
                (value ?? "local") as TimeZonePreference
              )
            }
            value={display.timeZonePreference}
          >
            <SelectTrigger
              aria-label="Display time zone"
              className="h-8 flex-1 text-xs"
            >
              <SelectValue>
                {zoneNames[display.timeZonePreference]} ·{" "}
                {timeZoneLabel(display.timeZone)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {timeZoneOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {zoneNames[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            aria-label={`Switch to ${display.theme === "dark" ? "light" : "dark"} theme`}
            onClick={() =>
              display.setTheme(display.theme === "dark" ? "light" : "dark")
            }
            size="icon-sm"
            variant="outline"
          >
            {display.theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

const rangeLabels: Record<string, string> = {
  "1": "Last hour",
  "6": "Last 6 hours",
  "24": "Last day",
};

export function AppHeader({
  page,
  clusterName,
  connection,
  range,
  onRange,
  onClearCluster,
  onFreeze,
  onSearch,
}: {
  page: string;
  clusterName?: string;
  connection: string;
  range: string;
  onRange: (range: string) => void;
  onClearCluster: () => void;
  onFreeze: (at?: string) => void;
  onSearch: () => void;
}) {
  const { frozen, at, timeZone } = useDisplay();
  const connected = connection === "connected";
  return (
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      <div className="flex min-h-13 flex-wrap items-center justify-between gap-2 px-4 py-2">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-2 text-sm"
        >
          <SidebarTrigger className="md:hidden" />
          <span className="text-muted-foreground">{page}</span>
          {clusterName && (
            <span className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs">
              <span className="truncate">{clusterName}</span>
              <Button
                aria-label={`Show all clusters instead of ${clusterName}`}
                className="size-5"
                onClick={onClearCluster}
                size="icon-xs"
                variant="ghost"
              >
                <X />
              </Button>
            </span>
          )}
        </nav>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Find resource"
            className="md:hidden"
            onClick={onSearch}
            size="icon-sm"
            variant="outline"
          >
            <Search />
          </Button>
          <Select
            onValueChange={(value) => onRange(value ?? "1")}
            value={range}
          >
            <SelectTrigger
              aria-label="History range for events and charts"
              className="h-8 w-auto gap-1.5 text-xs"
            >
              <History className="size-3.5 text-muted-foreground" />
              <SelectValue>{rangeLabels[range]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(rangeLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Rendered at every width so changes are announced. Phones show
              only the dot while live; the text appears whenever the stream
              is reconnecting or the view is frozen. */}
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
              frozen && "border-info/40 text-info-text",
              !(frozen || connected) && "border-warning/40 text-warning-text"
            )}
            role="status"
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
            <span
              className={cn(!frozen && connected && "sr-only sm:not-sr-only")}
            >
              {frozen && "Frozen"}
              {!frozen && (connected ? "Live" : "Reconnecting…")}
            </span>
          </span>
          <Button
            className="h-8 gap-1.5 text-xs"
            onClick={() =>
              onFreeze(frozen ? undefined : new Date().toISOString())
            }
            size="sm"
            variant="outline"
          >
            {frozen ? (
              <Play className="size-3.5" />
            ) : (
              <Pause className="size-3.5" />
            )}
            {frozen ? "Resume live" : "Freeze"}
          </Button>
          <ObservationTime at={at} onSelect={(value) => onFreeze(value)} />
        </div>
      </div>
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
            className="h-7 text-xs"
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
