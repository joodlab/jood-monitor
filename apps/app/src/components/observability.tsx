import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import type { UseQueryResult } from "@tanstack/react-query";
import { Server } from "lucide-react";
import type { Attention } from "../lib/attention";
import type { SearchState } from "../schemas/monitor";
import type { AttentionActions } from "./attention-list";
import { ClustersWidget, FleetWidget } from "./fleet-overview";
import { EmptyState } from "./page";
import { ActivityWidget } from "./widget-activity";
import { AttentionWidget } from "./widget-attention";
import { ServersWidget } from "./widget-servers";

export interface ObservabilityProps {
  actions: AttentionActions;
  attention: Attention[];
  clusterFilter?: string;
  events: UseQueryResult<Lifecycle[], Error>;
  onCluster: (view: ClusterView) => void;
  onConnect: () => void;
  onNavigate: (view: string, extra?: Partial<SearchState>) => void;
  views: ClusterView[];
  workspaceNames: Record<string, string>;
}

function FirstCluster({ onConnect }: { onConnect: () => void }) {
  return (
    <section
      aria-labelledby="first-cluster"
      className="rounded-xl border bg-card p-6 sm:p-8"
    >
      <span
        aria-hidden
        className="mb-4 flex size-10 items-center justify-center rounded-full border bg-muted/40"
      >
        <Server className="size-5 text-muted-foreground" />
      </span>
      <h2 className="font-semibold text-base" id="first-cluster">
        Connect your first cluster
      </h2>
      <p className="mt-1 max-w-xl text-muted-foreground text-sm">
        Create an enrollment, install the observer with Helm, and these widgets
        fill in as soon as the first heartbeat and inventory arrive.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button onClick={onConnect}>Connect a cluster</Button>
        <Button
          nativeButton={false}
          render={<a href="/docs/agents">Installation guide</a>}
          variant="outline"
        />
      </div>
    </section>
  );
}

// Railway-style observability dashboard: a grid of widget cards. Reading
// order follows the grid: problems first, then fleet totals, clusters,
// servers and recent activity.
export function Observability(props: ObservabilityProps) {
  const { views, attention, actions, events, onNavigate } = props;
  if (!views.length) {
    return props.clusterFilter ? (
      <EmptyState
        description="This cluster is not in the selected workspace. Show every cluster or switch workspace."
        icon={Server}
        title="Cluster not found"
      >
        <Button
          onClick={() => onNavigate("observability", { cluster: undefined })}
          size="sm"
          variant="outline"
        >
          Show all clusters
        </Button>
      </EmptyState>
    ) : (
      <FirstCluster onConnect={props.onConnect} />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <AttentionWidget
        actions={actions}
        attention={attention}
        className="xl:col-span-2"
        views={views}
      />
      <FleetWidget
        attention={attention}
        onNavigate={onNavigate}
        views={views}
      />
      <ClustersWidget
        attention={attention}
        className="xl:col-span-3"
        onCluster={props.onCluster}
        onNavigate={onNavigate}
        views={views}
        workspaceNames={props.workspaceNames}
      />
      <ServersWidget
        className="xl:col-span-2"
        onAll={() => onNavigate("resources", { tab: "servers" })}
        onInspect={actions.onInspect}
        views={views}
      />
      <ActivityWidget
        events={events}
        onAll={() => onNavigate("activity")}
        views={views}
      />
    </div>
  );
}
