import type { ClusterView } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { cn } from "@jood-monitor/ui/utils";
import { ArrowRight, Layers, Plus } from "lucide-react";
import { useDisplay } from "../hooks/display";
import { SeverityIcon, severityTone } from "./severity";
import { type WorkspaceCard, workspaceCards } from "./widget-model";

export interface WorkspacesPageProps {
  // Hides the grid while the workspace list is still loading.
  loading?: boolean;
  onNewWorkspace: () => void;
  onOpen: (workspace: string) => void;
  // Workspace the loaded snapshot is scoped to ("global" for all). Counts
  // are only claimed for workspaces whose clusters are loaded.
  scope?: string;
  views: ClusterView[];
  workspaces: { id: string; name: string }[];
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function Health({ card }: { card: WorkspaceCard }) {
  if (!card.health) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-sm">
        <SeverityIcon decorative />
        Open to load its clusters
      </span>
    );
  }
  const { health } = card;
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-sm",
        severityTone(health.severity, health.covered)
      )}
    >
      <SeverityIcon
        covered={health.covered}
        decorative
        severity={health.severity}
      />
      {health.label}
    </span>
  );
}

function names(card: WorkspaceCard) {
  const shown = card.clusterNames.slice(0, 3).join(", ");
  const more = card.clusterNames.length - 3;
  return more > 0 ? `${shown} +${more}` : shown;
}

function Tile({
  card,
  subtitle,
  all = false,
  onOpen,
}: {
  card: WorkspaceCard;
  subtitle: string;
  all?: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      aria-current={card.current ? "true" : undefined}
      className={cn(
        "group flex h-full min-h-44 w-full flex-col rounded-xl border bg-card p-5 text-left outline-none transition-colors hover:border-ring/40 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring",
        card.current && "border-primary/50"
      )}
      onClick={() => onOpen(card.id)}
      type="button"
    >
      <span className="flex w-full items-start justify-between gap-3">
        <span className="flex min-w-0 items-start gap-2.5">
          {all && (
            <Layers
              aria-hidden
              className="mt-1 size-4 shrink-0 text-muted-foreground"
            />
          )}
          <span className="min-w-0">
            <span className="block truncate font-semibold text-base">
              {card.name}
            </span>
            <span
              className={cn(
                "mt-0.5 block truncate text-muted-foreground text-xs",
                !all && "font-mono"
              )}
            >
              {subtitle}
            </span>
          </span>
        </span>
        {card.current ? (
          <Badge variant="outline">Current</Badge>
        ) : (
          <ArrowRight
            aria-hidden
            className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        )}
      </span>
      <span className="mt-4 block">
        <Health card={card} />
      </span>
      {card.loaded && card.clusterNames.length > 0 && (
        <span className="mt-1 block truncate text-muted-foreground text-xs">
          {names(card)}
        </span>
      )}
      <span className="mt-auto block pt-5 text-muted-foreground text-sm">
        {card.loaded
          ? `${plural(card.clusters, "cluster")} · ${plural(card.servers, "server")}`
          : "Not in the loaded view"}
      </span>
    </button>
  );
}

// Railway-style home: one card per workspace plus "All workspaces". Health
// is computed from the loaded clusters; green needs observed coverage.
export function WorkspacesPage({
  workspaces,
  views,
  scope,
  loading = false,
  onOpen,
  onNewWorkspace,
}: WorkspacesPageProps) {
  const { referenceTime, frozen } = useDisplay();
  const cards = workspaceCards(workspaces, views, referenceTime, frozen, scope);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {loading
            ? "Loading workspaces…"
            : plural(workspaces.length, "workspace")}
        </p>
        <Button
          className="h-8"
          onClick={onNewWorkspace}
          size="sm"
          variant="outline"
        >
          <Plus aria-hidden className="size-3.5" />
          New workspace
        </Button>
      </div>
      {loading ? (
        <div
          aria-busy="true"
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {[1, 2, 3].map((item) => (
            <Skeleton className="h-44 rounded-xl" key={item} />
          ))}
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <li>
            <Tile
              all
              card={cards.all}
              onOpen={onOpen}
              subtitle={`Every cluster across ${plural(workspaces.length, "workspace")}`}
            />
          </li>
          {cards.workspaces.map((card) => (
            <li key={card.id}>
              <Tile card={card} onOpen={onOpen} subtitle={card.id} />
            </li>
          ))}
          {workspaces.length === 0 && (
            <li>
              <button
                className="flex h-full min-h-44 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 text-center text-muted-foreground text-sm outline-none transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                onClick={onNewWorkspace}
                type="button"
              >
                <Plus aria-hidden className="size-5" />
                Create a workspace to group clusters
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
