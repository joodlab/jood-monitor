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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@jood-monitor/ui/tabs";
import { BookOpen, CircleHelp, Radio } from "lucide-react";
import { freshness } from "../lib/metrics";
import type { SearchState } from "../schemas/monitor";
import { ProfileForm } from "./profile-form";

export function CollectionSettings({
  search,
  views,
  referenceTime,
  onResumeLive,
}: {
  search: SearchState;
  views: ClusterView[];
  referenceTime: number;
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
        <TabsTrigger value="appearance">Capabilities</TabsTrigger>
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
