import type { ClusterView } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@jood-monitor/ui/card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchWorkspaces } from "../hooks/api/clusters";
import { useDisplay } from "../hooks/display";
import type { SearchState } from "../schemas/monitor";
import { ClusterCollection } from "./collection-cluster";
import {
  type AckRequest,
  ackPollDelay,
  latestPendingRequest,
} from "./collection-model";
import { EmptyState, Section } from "./page";

const capabilityLabels: Record<string, string> = {
  inventory: "Kubernetes inventory",
  host_proc: "Host counters",
  token_review: "Node identity (TokenReview)",
  metrics_api: "Metrics API",
  metrics_api_unavailable: "Metrics API unavailable",
  inventory_unavailable: "Inventory unavailable",
};

function AvailableSources({ views }: { views: ClusterView[] }) {
  return (
    <Section
      description="What each observer reports it can collect. Topology shows configured and discovered structure, not traffic."
      title="Available sources"
    >
      <Card size="sm">
        <CardContent className="space-y-3 text-sm">
          <p>
            Kubernetes inventory, owner references, EndpointSlices, ingress
            routes and supported resource metrics.
          </p>
          <p className="text-muted-foreground text-xs">
            Service connections and HTTP request metrics require another
            measured source. Beyla and tracing are deferred.
          </p>
          <ul className="space-y-2">
            {views.map((view) => {
              const capabilities = view.heartbeat.capabilities ?? [];
              return (
                <li
                  className="flex flex-wrap items-center gap-1.5 text-xs"
                  key={view.cluster.id}
                >
                  <span className="mr-1 font-medium">{view.cluster.name}</span>
                  {capabilities.length ? (
                    capabilities.map((capability) => (
                      <Badge
                        key={capability}
                        variant={
                          capability.endsWith("_unavailable")
                            ? "warning"
                            : "outline"
                        }
                      >
                        {capabilityLabels[capability] ?? capability}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">
                      Not reported yet
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <a
            className="inline-flex items-center gap-1.5 text-primary text-xs underline underline-offset-2"
            href="/docs/metrics"
          >
            <BookOpen aria-hidden className="size-3.5" />
            Metrics and collection documentation
          </a>
        </CardContent>
      </Card>
    </Section>
  );
}

type Requests = Partial<Record<string, AckRequest>>;

// One poller for the whole page. While any card's request awaits
// acknowledgment, the displayed live snapshot is refreshed on a capped backoff
// (10 s, 20 s, then every 30 s) from the latest request until the patience
// window ends. Hidden tabs skip refreshes; the query refetches on focus. A
// slow scope-wide fetch is not cancelled by the next tick.
function useAcknowledgmentPolling(
  views: ClusterView[],
  requests: Requests,
  search: SearchState
) {
  const client = useQueryClient();
  const { now } = useDisplay();
  const live = !search.at;
  const since = live ? latestPendingRequest(views, requests, now) : undefined;
  const scope = search.workspace;
  useEffect(() => {
    if (since === undefined) {
      return;
    }
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delay = ackPollDelay(attempt, Date.now() - since);
      timer = delay === undefined ? undefined : setTimeout(tick, delay);
    };
    const tick = () => {
      attempt += 1;
      if (document.visibilityState === "visible") {
        client.invalidateQueries(
          { queryKey: ["snapshot", scope, "live"] },
          { cancelRefetch: false }
        );
      }
      schedule();
    };
    schedule();
    return () => clearTimeout(timer);
  }, [client, scope, since]);
}

export function CollectionSettings({
  search,
  views,
  onResumeLive,
}: {
  search: SearchState;
  views: ClusterView[];
  onResumeLive: () => void;
}) {
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });
  const [requests, setRequests] = useState<Requests>({});
  useAcknowledgmentPolling(views, requests, search);
  if (search.at) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Collection status is not retained historically</CardTitle>
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
  if (!views.length) {
    return (
      <EmptyState
        description={
          search.cluster
            ? "This cluster is not in the selected workspace. Clear the cluster filter or switch workspace."
            : "Use Connect cluster to register a cluster and install its observer. Collection settings appear here once it is registered."
        }
        icon={Server}
        title={
          search.cluster ? "Cluster not found" : "No clusters connected yet"
        }
      />
    );
  }
  const names = Object.fromEntries(
    (workspaces.data ?? []).map((item) => [item.id, item.name])
  );
  return (
    <div className="space-y-6">
      {views.map((view) => (
        <ClusterCollection
          focused={search.cluster === view.cluster.id}
          initialNodeUid={
            search.cluster === view.cluster.id
              ? search.diagnosticNode
              : undefined
          }
          key={view.cluster.id}
          onRequest={(request) =>
            setRequests((current) => ({
              ...current,
              [view.cluster.id]: request,
            }))
          }
          request={requests[view.cluster.id]}
          view={view}
          workspaceName={
            names[view.cluster.workspaceId] ?? view.cluster.workspaceId
          }
        />
      ))}
      <AvailableSources views={views} />
    </div>
  );
}
