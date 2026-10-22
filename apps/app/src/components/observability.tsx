import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Attention } from "../lib/attention";
import type { SearchState } from "../schemas/monitor";
import type { AttentionActions } from "./attention-list";
import { AttentionPage } from "./attention-page";
import { FleetOverview } from "./fleet-overview";

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

// Railway-style observability dashboard. Placeholder composition until the
// widget grid lands.
export function Observability(props: ObservabilityProps) {
  return (
    <div className="space-y-8">
      <FleetOverview
        actions={props.actions}
        attention={props.attention}
        events={props.events}
        onCluster={props.onCluster}
        onConnect={props.onConnect}
        onNavigate={props.onNavigate}
        views={props.views}
        workspaceNames={props.workspaceNames}
      />
      <AttentionPage
        actions={props.actions}
        attention={props.attention}
        clusterFilter={props.clusterFilter}
        views={props.views}
      />
    </div>
  );
}
