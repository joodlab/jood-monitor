import type { Snapshot } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { DialogClose } from "@jood-monitor/ui/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { fetchSnapshot } from "../hooks/api/clusters";
import {
  credentialFile,
  credentialSecret,
  observerNamespace,
} from "../lib/install-commands";
import {
  deliveryCheckInterval,
  type Enrollment,
  elapsed,
  type FirstDelivery,
  firstDelivery,
  firstHeartbeatPatienceMs,
  issuedAt,
} from "../lib/install-enrollment";
import { CommandBlock, DocLink, Notice, useNow } from "./connect-parts";
import { TimeText } from "./time";

// The dashboard's own live snapshot key for a workspace.
function liveSnapshotKey(workspace: string) {
  return ["snapshot", workspace, "live"];
}

// Reads every cached snapshot for a delivery newer than the enrollment. It
// only subscribes: the First heartbeat step does the checking, and on the
// Install step new data arrives with the dashboard's own refreshes.
export function useFirstDelivery(enrollment?: Enrollment): FirstDelivery {
  const client = useQueryClient();
  const workspace = enrollment?.cluster.workspaceId ?? "";
  useQuery({
    queryKey: liveSnapshotKey(workspace),
    queryFn: () => fetchSnapshot(workspace),
    enabled: false,
    notifyOnChangeProps: ["data"],
  });
  const since = enrollment ? issuedAt(enrollment.expiresAt) : 0;
  const views = client
    .getQueriesData<Snapshot>({ queryKey: ["snapshot"] })
    .flatMap(([, data]) => data?.clusters ?? []);
  const delivery = enrollment
    ? firstDelivery(views, enrollment.cluster.id, since)
    : { state: "waiting" as const, servers: 0 };
  const connected = delivery.state !== "waiting";
  useEffect(() => {
    // Refresh every other scope, such as "All workspaces", once it arrives.
    if (connected) {
      client.invalidateQueries({ queryKey: ["snapshot"] });
    }
  }, [connected, client]);
  return delivery;
}

interface DeliveryChecks {
  checking: boolean;
  checkNow: () => void;
  // The first heartbeat seen while waiting; the snapshot only holds the latest.
  firstHeartbeatAt?: string;
  interval: number | false;
}

// Checks the hub only while the First heartbeat step is open, on the cadence
// from deliveryCheckInterval measured from when the step started. Hidden tabs
// skip checks. Once automatic checks stop, only "Check now" fetches.
function useDeliveryChecks(
  enrollment: Enrollment,
  delivery: FirstDelivery,
  startedAt: number,
  now: number
): DeliveryChecks {
  const workspace = enrollment.cluster.workspaceId;
  // The inventory patience window runs from the FIRST heartbeat seen; the
  // latest heartbeat keeps moving and would never let checks stop.
  const [firstHeartbeatAt, setFirstHeartbeatAt] = useState<string>();
  useEffect(() => {
    if (delivery.state !== "waiting" && delivery.heartbeatAt) {
      setFirstHeartbeatAt((first) => first ?? delivery.heartbeatAt);
    }
  }, [delivery.state, delivery.heartbeatAt]);
  const interval = deliveryCheckInterval({
    state: delivery.state,
    startedAt,
    expiresAt: enrollment.expiresAt,
    heartbeatAt: firstHeartbeatAt ?? delivery.heartbeatAt,
    now,
  });
  const query = useQuery({
    queryKey: liveSnapshotKey(workspace),
    queryFn: () => fetchSnapshot(workspace),
    enabled: interval !== false,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  return {
    interval,
    checking: query.isFetching,
    firstHeartbeatAt,
    // Joins a check already in flight instead of restarting it.
    checkNow: () => {
      query.refetch({ cancelRefetch: false });
    },
  };
}

function CheckNow({ checks }: { checks: DeliveryChecks }) {
  return (
    <Button
      className="h-8"
      onClick={checks.checkNow}
      size="sm"
      type="button"
      variant="outline"
    >
      <RefreshCw
        className={checks.checking ? "motion-safe:animate-spin" : ""}
      />
      {checks.checking ? "Checking…" : "Check now"}
    </Button>
  );
}

function checkingText(interval: number | false, stopped: string) {
  return interval === false
    ? stopped
    : `Checking every ${interval / 1000} seconds`;
}

function CredentialAdvice({ enrollment }: { enrollment: Enrollment }) {
  const file = credentialFile(enrollment.cluster.id, enrollment.kind);
  return (
    <>
      <li>
        If the helper printed “Scoped credential saved privately”, the token is
        spent and the credential is in <code>{file}</code> or, once stored, the{" "}
        <code>{credentialSecret}</code> Secret. Install the observer with that
        credential; the hub refuses renewal while it is active.
      </li>
      <li>
        If the helper failed with HTTP 401 and never printed that line, the
        token had expired or another run had already exchanged it. For an
        expired token, renew the enrollment.
      </li>
      <li>
        If an exchange succeeded but its credential is lost, an authorized
        operator must revoke the cluster's credential first, then renew.
      </li>
    </>
  );
}

function Troubleshooting({ enrollment }: { enrollment: Enrollment }) {
  const namespace = observerNamespace;
  const pods = "-l app=jood-monitor-observer";
  return (
    <Notice
      icon={<TriangleAlert className="size-4" />}
      title="Nothing yet after two minutes"
      tone="warning"
    >
      <ul className="list-disc space-y-1 pl-4 text-xs">
        <CredentialAdvice enrollment={enrollment} />
        <li>
          If the observer Pod is not Running, <code>kubectl describe</code>{" "}
          shows missing Secret mounts or image problems. A crash-looping Pod's
          log shows the startup error, such as a non-HTTPS hub URL or an
          unreadable TLS certificate.
        </li>
        <li>
          A Running and Ready observer with an empty log can still be rejected
          by the hub (wrong or used-up credential) or unable to reach it. The
          observer does not log delivery failures.
        </li>
        <li>
          The hub URL must be the exact HTTPS origin, with no path, reachable
          from the cluster.
        </li>
      </ul>
      <CommandBlock
        command={[
          `kubectl -n ${namespace} get pods ${pods}`,
          `kubectl -n ${namespace} describe pod ${pods}`,
          `kubectl -n ${namespace} logs deployment/jood-monitor-observer --tail=50`,
          `kubectl -n ${namespace} describe secret ${credentialSecret}`,
        ].join("\n")}
        label="diagnostic commands"
      />
      <p className="text-muted-foreground text-xs">
        <code>describe secret</code> shows that the <code>credential</code> key
        exists and its size, without printing the value.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <DocLink href="/docs/troubleshooting#authentication-or-enrollment-failed">
          Troubleshooting guide
        </DocLink>
        <DocLink href="/docs/agents#revoke-credential">
          Revoke an active credential
        </DocLink>
      </div>
    </Notice>
  );
}

function InventoryProgress({ checks }: { checks: DeliveryChecks }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-muted-foreground text-xs tabular-nums">
        {checkingText(
          checks.interval,
          "Automatic checks stopped ten minutes after the heartbeat."
        )}
      </p>
      {checks.interval === false && <CheckNow checks={checks} />}
    </div>
  );
}

function Connected({
  enrollment,
  delivery,
  checks,
  onAnother,
}: {
  enrollment: Enrollment;
  delivery: FirstDelivery;
  checks: DeliveryChecks;
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
            value={checks.firstHeartbeatAt ?? delivery.heartbeatAt}
          />
          {delivery.version ? ` from observer ${delivery.version}` : ""}.
          {inventory
            ? " Node collectors acknowledge the collection profile separately."
            : " Inventory usually follows within a minute."}
        </p>
        {!inventory && <InventoryProgress checks={checks} />}
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
  checks,
}: {
  name: string;
  now: number;
  waitingSince: number;
  checks: DeliveryChecks;
}) {
  const stopped = checks.interval === false;
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <CircleDashed
        aria-hidden
        className={
          stopped
            ? "mt-0.5 size-4 shrink-0 text-muted-foreground"
            : "mt-0.5 size-4 shrink-0 text-muted-foreground motion-safe:animate-spin motion-safe:[animation-duration:3s]"
        }
      />
      <div className="min-w-0 space-y-2">
        <div className="space-y-0.5">
          <p className="font-medium text-sm">
            Waiting for the first heartbeat from {name}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {checkingText(
              checks.interval,
              "Automatic checks stopped because the token expired"
            )}{" "}
            · {elapsed(waitingSince, now)} elapsed.{" "}
            {stopped
              ? "A heartbeat can still arrive if the helper exchanged the token in time."
              : "No heartbeat yet is not a failure; the observer reports within a minute of starting."}
          </p>
        </div>
        {stopped && <CheckNow checks={checks} />}
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
  const checks = useDeliveryChecks(enrollment, delivery, waitingSince, now);
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
          checks={checks}
          name={enrollment.cluster.name}
          now={now}
          waitingSince={waitingSince}
        />
      ) : (
        <Connected
          checks={checks}
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
      {waiting && !patient && <Troubleshooting enrollment={enrollment} />}
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
