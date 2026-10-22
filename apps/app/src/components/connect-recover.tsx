import type { ClusterView } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Label } from "@jood-monitor/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { recoverEnrollmentFn } from "../functions/clusters";
import type { Enrollment } from "../lib/install-enrollment";
import { requestError } from "../lib/install-errors";
import { Notice } from "./connect-parts";
import { TimeText } from "./time";

type Cluster = ClusterView["cluster"];

// What the hub will most likely do, from what the operator view can see.
// Credential state itself is never exposed to operators.
function RenewalHint({ cluster }: { cluster: Cluster }) {
  if (cluster.revoked) {
    return (
      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        Credential revoked. Renewal issues a new one-time token.
      </p>
    );
  }
  if (!cluster.heartbeatAt) {
    return (
      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        Never reported. Renewal replaces an unused or expired token.
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-warning-text text-xs">
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>
        Reported with a credential (last heartbeat{" "}
        <TimeText label="Last heartbeat received" value={cluster.heartbeatAt} />
        ). Unless that credential was revoked, the hub refuses renewal.
      </span>
    </p>
  );
}

export function ConnectRecover({
  clusters,
  initial,
  onRenewed,
  onNewCluster,
}: {
  clusters: Cluster[];
  initial?: Cluster | { id: string };
  onRenewed: (enrollment: Enrollment) => void;
  onNewCluster: () => void;
}) {
  const options =
    initial && "name" in initial && !clusters.some((c) => c.id === initial.id)
      ? [initial, ...clusters]
      : clusters;
  const [id, setId] = useState(() =>
    initial && options.some((cluster) => cluster.id === initial.id)
      ? initial.id
      : ""
  );
  const selected = options.find((cluster) => cluster.id === id);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (clusterId: string) =>
      recoverEnrollmentFn({ data: clusterId, headers: { "X-Jood-CSRF": "1" } }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["snapshot"] });
      onRenewed({ ...result, kind: "recover" });
    },
  });
  const error = mutation.isError ? requestError(mutation.error) : undefined;
  return (
    <form
      aria-label="Renew an existing enrollment"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (id) {
          mutation.mutate(id);
        }
      }}
    >
      <div className="space-y-2 text-sm">
        <p className="font-medium">Renew an existing enrollment</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Issues a new one-time token for the same cluster ID.</li>
          <li>History, workspace and collection settings stay intact.</li>
          <li>Any earlier unused enrollment token stops working.</li>
          <li>
            A cluster with an active credential must have it revoked first;
            renewal never revokes or rotates credentials.
          </li>
        </ul>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="recover-cluster">Cluster</Label>
        <Select
          items={Object.fromEntries(
            options.map((cluster) => [
              cluster.id,
              `${cluster.name} · ${cluster.id}`,
            ])
          )}
          onValueChange={(value) => {
            setId(value ?? "");
            mutation.reset();
          }}
          value={id}
        >
          <SelectTrigger
            aria-describedby="recover-cluster-hint"
            className="w-full"
            disabled={!options.length}
            id="recover-cluster"
          >
            <SelectValue placeholder="Choose a cluster" />
          </SelectTrigger>
          <SelectContent>
            {options.map((cluster) => (
              <SelectItem key={cluster.id} value={cluster.id}>
                {cluster.name}
                <span className="font-mono text-muted-foreground text-xs">
                  {cluster.id}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div id="recover-cluster-hint">
          {selected && <RenewalHint cluster={selected} />}
          {!options.length && (
            <p className="text-muted-foreground text-xs">
              No clusters in this workspace. Switch workspace from the sidebar
              to renew a cluster elsewhere.
            </p>
          )}
        </div>
      </div>
      {error && (
        <Notice
          icon={<CircleAlert className="size-4" />}
          role="alert"
          tone="destructive"
        >
          <p>{error.message}</p>
          {error.kind === "active-credential" && (
            <a
              className="inline-flex items-center gap-1.5 text-primary text-xs underline underline-offset-2"
              href="/docs/agents#credential-recovery"
            >
              <BookOpen aria-hidden className="size-3.5" />
              Credential recovery guide
            </a>
          )}
        </Notice>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button
          className="h-8 px-0"
          onClick={onNewCluster}
          size="sm"
          type="button"
          variant="link"
        >
          Connect a new cluster instead
        </Button>
        <Button disabled={!id || mutation.isPending} type="submit">
          {mutation.isPending ? "Renewing…" : "Renew enrollment"}
        </Button>
      </div>
    </form>
  );
}
