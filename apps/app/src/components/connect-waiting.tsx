import type { Snapshot } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { DialogClose } from "@jood-monitor/ui/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  BookOpen,
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { fetchSnapshot } from "../hooks/api/clusters";
import { observerNamespace } from "../lib/install-commands";
import {
  type Enrollment,
  elapsed,
  type FirstDelivery,
  firstDelivery,
  firstHeartbeatPatienceMs,
  issuedAt,
  pollIntervalMs,
} from "../lib/install-enrollment";
import { CommandBlock, Notice, useNow } from "./connect-parts";
import { TimeText } from "./time";

const slowPollAfterMs = 10 * 60_000;

// Polls the new cluster's workspace snapshot while the dialog is open and
// reads every cached snapshot for a delivery newer than the enrollment.
export function useFirstDelivery(enrollment?: Enrollment): FirstDelivery {
  const client = useQueryClient();
  const started = useRef(Date.now());
  const workspace = enrollment?.cluster.workspaceId ?? "";
  const since = enrollment ? issuedAt(enrollment.expiresAt) : 0;
  const views = client
    .getQueriesData<Snapshot>({ queryKey: ["snapshot"] })
    .flatMap(([, data]) => data?.clusters ?? []);
  const delivery = enrollment
    ? firstDelivery(views, enrollment.cluster.id, since)
    : { state: "waiting" as const, servers: 0 };
  const done = delivery.state === "inventory";
  useQuery({
    queryKey: ["snapshot", workspace, "live"],
    queryFn: () => fetchSnapshot(workspace),
    enabled: !!enrollment,
    refetchInterval: () => {
      if (done) {
        return false;
      }
      return Date.now() - started.current > slowPollAfterMs
        ? 30_000
        : pollIntervalMs;
    },
  });
  const connected = delivery.state !== "waiting";
  useEffect(() => {
    // Refresh every other scope, such as "All workspaces", once it arrives.
    if (connected) {
      client.invalidateQueries({ queryKey: ["snapshot"] });
    }
  }, [connected, client]);
  return delivery;
}

function Troubleshooting() {
  const namespace = observerNamespace;
  return (
    <Notice
      icon={<TriangleAlert className="size-4" />}
      title="Nothing yet after two minutes"
      tone="warning"
    >
      <ul className="list-disc space-y-1 pl-4 text-xs">
        <li>
          Confirm the helper printed “Scoped credential saved privately”. A
          token works once; if an attempt consumed it, renew the enrollment.
        </li>
        <li>
          The observer Pod should be Running and Ready; its log names TLS,
          authentication or hub address problems.
        </li>
        <li>
          The hub URL must be the exact HTTPS origin, with no path, reachable
          from the cluster.
        </li>
      </ul>
      <CommandBlock
        command={[
          `kubectl -n ${namespace} get pods`,
          `kubectl -n ${namespace} logs deployment/jood-monitor-observer --tail=50`,
        ].join("\n")}
        label="diagnostic commands"
      />
      <a
        className="inline-flex items-center gap-1.5 text-primary text-xs underline underline-offset-2"
        href="/docs/troubleshooting#authentication-or-enrollment-failed"
        rel="noopener"
        target="_blank"
      >
        <BookOpen aria-hidden className="size-3.5" />
        Troubleshooting guide
      </a>
    </Notice>
  );
}

function Connected({
  enrollment,
  delivery,
  onAnother,
}: {
  enrollment: Enrollment;
  delivery: FirstDelivery;
  onAnother: () => void;
}) {
  const navigate = useNavigate({ from: "/" });
  const { cluster } = enrollment;
  const open = (view: string, mode?: string) =>
    navigate({
      search: (old) => ({
        ...old,
        view,
        ...(mode ? { mode } : {}),
        workspace: cluster.workspaceId,
        cluster: cluster.id,
        at: undefined,
        resource: undefined,
        resourceCluster: undefined,
        diagnosticNode: undefined,
      }),
    });
  const inventory = delivery.state === "inventory";
  return (
    <div className="space-y-4">
      <Notice
        icon={
          inventory ? (
            <CircleCheck className="size-4" />
          ) : (
            <LoaderCircle className="size-4 motion-safe:animate-spin" />
          )
        }
        title={
          inventory
            ? `Observer connected · ${delivery.servers} server${delivery.servers === 1 ? "" : "s"} discovered`
            : "Observer connected · waiting for the first inventory"
        }
        tone={inventory ? "success" : "info"}
      >
        <p className="text-muted-foreground text-xs">
          First heartbeat received{" "}
          <TimeText
            label="Heartbeat received by the hub"
            value={delivery.heartbeatAt}
          />
          {delivery.version ? ` from observer ${delivery.version}` : ""}.
          {inventory
            ? " Node collectors acknowledge the collection profile separately."
            : " Inventory usually follows within a minute."}
        </p>
      </Notice>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button onClick={onAnother} size="sm" type="button" variant="ghost">
          Connect another cluster
        </Button>
        <DialogClose
          onClick={() => open("settings")}
          render={<Button className="h-9" variant="outline" />}
        >
          Collection settings
        </DialogClose>
        <DialogClose
          onClick={() => open("infrastructure", "servers")}
          render={<Button className="h-9" />}
        >
          View cluster
        </DialogClose>
      </div>
    </div>
  );
}

function statusMessage(delivery: FirstDelivery, name: string) {
  if (delivery.state === "inventory") {
    return `Observer connected. ${delivery.servers} servers discovered.`;
  }
  return delivery.state === "heartbeat"
    ? "Observer connected. Waiting for the first inventory."
    : `Waiting for the first heartbeat from ${name}.`;
}

function WaitingStatus({
  name,
  now,
  waitingSince,
}: {
  name: string;
  now: number;
  waitingSince: number;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <CircleDashed
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground motion-safe:animate-spin motion-safe:[animation-duration:3s]"
      />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-sm">
          Waiting for the first heartbeat from {name}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          Checking every {pollIntervalMs / 1000} seconds ·{" "}
          {elapsed(waitingSince, now)} elapsed. No heartbeat yet is not a
          failure; the observer reports within a minute of starting.
        </p>
      </div>
    </div>
  );
}

export function ConnectWaiting({
  enrollment,
  delivery,
  waitingSince,
  onBack,
  onRenew,
  onAnother,
}: {
  enrollment: Enrollment;
  delivery: FirstDelivery;
  waitingSince: number;
  onBack: () => void;
  onRenew: () => void;
  onAnother: () => void;
}) {
  const now = useNow();
  const waiting = delivery.state === "waiting";
  const expired = Date.parse(enrollment.expiresAt) <= now;
  const patient = now - waitingSince < firstHeartbeatPatienceMs;
  return (
    <div className="space-y-4">
      <p className="sr-only" role="status">
        {statusMessage(delivery, enrollment.cluster.name)}
      </p>
      {waiting ? (
        <WaitingStatus
          name={enrollment.cluster.name}
          now={now}
          waitingSince={waitingSince}
        />
      ) : (
        <Connected
          delivery={delivery}
          enrollment={enrollment}
          onAnother={onAnother}
        />
      )}
      {waiting && expired && (
        <Notice icon={<TriangleAlert className="size-4" />} tone="warning">
          <p className="text-xs">
            The enrollment token has expired. If the helper exchanged it in
            time, keep waiting; otherwise renew the enrollment for a new token.
          </p>
          <Button className="h-8" onClick={onRenew} size="sm" variant="outline">
            Renew enrollment
          </Button>
        </Notice>
      )}
      {waiting && !patient && <Troubleshooting />}
      {waiting && (
        <Button
          className="h-8"
          onClick={onBack}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ArrowLeft />
          Back to install commands
        </Button>
      )}
    </div>
  );
}
