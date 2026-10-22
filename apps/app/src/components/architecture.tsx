import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Attention } from "../lib/attention";
import type { SearchState } from "../schemas/monitor";
import type { AttentionActions } from "./attention-list";
import { ResourceBrowser } from "./resource-browser";

export interface ArchitectureProps {
  actions: AttentionActions;
  allViews: ClusterView[];
  attention: Attention[];
  events: UseQueryResult<Lifecycle[], Error>;
  inspect: (view: ClusterView, entity: Entity) => void;
  namespaces: string[];
  onConnect: () => void;
  onNavigate: (view: string, extra?: Partial<SearchState>) => void;
  referenceTime: number;
  search: SearchState;
  update: (next: Partial<SearchState>, replace?: boolean) => void;
  views: ClusterView[];
}

// Railway-style architecture canvas. Placeholder until the canvas lands.
export function Architecture(props: ArchitectureProps) {
  return (
    <div className="p-4">
      <h1 className="sr-only">Architecture</h1>
      <ResourceBrowser
        allViews={props.allViews}
        inspect={props.inspect}
        namespaces={props.namespaces}
        referenceTime={props.referenceTime}
        search={{ ...props.search, view: "infrastructure", mode: "services" }}
        update={props.update}
        views={props.views}
      />
    </div>
  );
}
