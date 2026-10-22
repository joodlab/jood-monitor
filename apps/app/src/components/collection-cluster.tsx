import type { ClusterView } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Card, CardContent, CardHeader } from "@jood-monitor/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@jood-monitor/ui/tooltip";
import { cn } from "@jood-monitor/ui/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  Clock,
  KeyRound,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { updateProfileFn } from "../functions/clusters";
import { useDisplay } from "../hooks/display";
import { minutesLeft } from "../lib/install-enrollment";
import { requestError } from "../lib/install-errors";
import { freshness } from "../lib/metrics";
import { formatClock, timeZoneLabel } from "../lib/time";
import { profileSchema } from "../schemas/clusters";
import {
  activeDiagnostic,
  formatBytes,
  nodeAcknowledgments,
  type ProfileDraft,
  profileChoices,
  profileLabel,
  profileRequest,
  requestProgress,
} from "./collection-model";
import { NodeAcknowledgments } from "./collection-nodes";
import { Notice } from "./connect-parts";
import { ProfileForm } from "./profile-form";
import { TimeText } from "./time";

const ackPollMs = 5000;
const ackPatienceMs = 3 * 60_000;

function Freshness({ value, label }: { value?: string | null; label: string }) {
  const { now } = useDisplay();
  const state = freshness(value, now);
  if (state === "unknown") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <CircleDashed aria-hidden className="size-3.5" />
        Not received yet
      </span>
    );
  }
  const fresh = state === "fresh";
  const Icon = fresh ? CircleCheck : TriangleAlert;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        fresh ? "text-foreground" : "text-warning-text"
      )}
    >
      <Icon
        aria-hidden
        className={cn("size-3.5", fresh ? "text-success-text" : "")}
      />
      <TimeText label={label} value={value} />
      {!fresh && <span>· {state}</span>}
    </span>
  );
}

function Stat({
  term,
  definition,
  value,
  warn,
}: {
  term: string;
  definition: string;
  value: string;
  warn: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <dt>
        <Tooltip>
          <TooltipTrigger className="cursor-help rounded-sm text-muted-foreground underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            {term}
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{definition}</TooltipContent>
        </Tooltip>
        <span className="text-muted-foreground">:</span>
      </dt>
      <dd
        className={cn(
          "inline-flex items-center gap-1 tabular-nums",
          warn && "text-warning-text"
        )}
      >
        {warn && <TriangleAlert aria-hidden className="size-3.5" />}
        {value}
      </dd>
    </div>
  );
}

function DeliveryHealth({ view }: { view: ClusterView }) {
  const reported = !!view.cluster.heartbeatAt;
  const { queueBytes, dropped, rejectedPoints } = view.heartbeat;
  const show = (value: string) => (reported ? value : "Not reported");
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
      <Stat
        definition="Telemetry waiting in the observer's bounded local spool for the hub to accept it. It drains once delivery succeeds."
        term="Buffered on agent"
        value={show(formatBytes(queueBytes))}
        warn={reported && queueBytes > 0}
      />
      <Stat
        definition="Batches the observer or node collectors discarded because a bounded buffer was full or entries expired. Dropped samples are missing, not zero."
        term="Dropped"
        value={show(String(dropped))}
        warn={reported && dropped > 0}
      />
      <Stat
        definition="Data points the hub refused, for example with an unknown unit, entity or an out-of-range time."
        term="Rejected points"
        value={show(String(rejectedPoints))}
        warn={reported && rejectedPoints > 0}
      />
    </dl>
  );
}

function ClusterHeader({
  view,
  workspaceName,
  headingId,
}: {
  view: ClusterView;
  workspaceName: string;
  headingId: string;
}) {
  const { cluster, profile, heartbeat } = view;
  return (
    <CardHeader className="gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold text-base" id={headingId}>
            {cluster.name}
          </h2>
          <p className="text-muted-foreground text-xs">
            <span className="font-mono">{cluster.id}</span> ·{" "}
            {cluster.environment || "No environment"} · {workspaceName}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{profileLabel(profile.name)} profile</Badge>
          {profile.paused && (
            <Badge variant="warning">
              <CirclePause aria-hidden />
              Paused
            </Badge>
          )}
          {cluster.revoked && (
            <Badge variant="destructive">
              <KeyRound aria-hidden />
              Credential revoked
            </Badge>
          )}
        </div>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Observer</dt>
          <dd className="font-mono">{heartbeat.version || "Not reported"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Heartbeat</dt>
          <dd>
            <Freshness
              label="Last heartbeat received by the hub"
              value={cluster.heartbeatAt}
            />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Inventory</dt>
          <dd className="flex flex-wrap gap-x-1.5">
            <Freshness
              label="Inventory source time (observer clock)"
              value={cluster.inventoryTime}
            />
            {cluster.receivedAt && (
              <span className="text-muted-foreground">
                · received{" "}
                <TimeText
                  label="Inventory received by the hub"
                  value={cluster.receivedAt}
                />
              </span>
            )}
          </dd>
        </div>
      </dl>
      <DeliveryHealth view={view} />
    </CardHeader>
  );
}

function ActiveDiagnostic({ view }: { view: ClusterView }) {
  const { now, timeZone } = useDisplay();
  const diagnostic = activeDiagnostic(view.profile, now);
  if (!diagnostic) {
    return null;
  }
  const names = diagnostic.nodeUids.map(
    (uid) =>
      view.inventory.entities.find((entity) => entity.uid === uid)?.name ?? uid
  );
  return (
    <Notice
      icon={<Timer className="size-4" />}
      title={`Diagnostic running on ${names.join(", ")}`}
      tone="info"
    >
      <p className="text-xs">
        {minutesLeft(diagnostic.expiresAt, now)} left (until{" "}
        {formatClock(diagnostic.expiresAt, timeZone)}{" "}
        {timeZoneLabel(timeZone, diagnostic.expiresAt)}), then the cluster
        returns to {profileChoices[diagnostic.returnTo].label}. Choose another
        profile and apply to end it early.
      </p>
    </Notice>
  );
}

interface RequestState {
  at: number;
  revision: number;
}

function progressText(
  progress: ReturnType<typeof requestProgress>,
  revision: number
) {
  const nodes = `${progress.acknowledged} of ${progress.total} node${progress.total === 1 ? "" : "s"} acknowledged`;
  const observer = progress.observerReceived
    ? "Observer received it"
    : "Waiting for the observer to pick it up (it checks about every 15 seconds)";
  switch (progress.phase) {
    case "syncing":
      return `Requested revision ${revision}. Loading the latest status…`;
    case "superseded":
      return `Revision ${revision} was replaced by a newer request.`;
    case "observer-stale":
      return `Requested revision ${revision}. The observer has no fresh heartbeat, so acknowledgments cannot be confirmed yet.`;
    case "complete":
      return `All ${progress.total} node${progress.total === 1 ? "" : "s"} acknowledged revision ${revision}.`;
    default:
      return progress.total
        ? `Requested revision ${revision}. ${observer} · ${nodes}.`
        : `Requested revision ${revision}. ${observer}. No nodes have reported yet.`;
  }
}

function RequestFeedback({
  view,
  request,
  mutation,
  validation,
}: {
  view: ClusterView;
  request?: RequestState;
  mutation: { isPending: boolean; isError: boolean; error: unknown };
  validation?: string;
}) {
  const { now } = useDisplay();
  if (validation) {
    return (
      <Notice
        icon={<CircleAlert className="size-4" />}
        role="alert"
        tone="destructive"
      >
        <p>{validation}</p>
      </Notice>
    );
  }
  if (mutation.isError) {
    return (
      <Notice
        icon={<CircleAlert className="size-4" />}
        role="alert"
        tone="destructive"
      >
        <p>{requestError(mutation.error).message}</p>
      </Notice>
    );
  }
  if (mutation.isPending) {
    return (
      <p className="text-muted-foreground text-sm">
        Sending the request to the hub…
      </p>
    );
  }
  if (!request) {
    return null;
  }
  const progress = requestProgress(view, request.revision, now);
  const complete = progress.phase === "complete";
  const slow = !complete && now - request.at > ackPatienceMs;
  const percent = progress.total
    ? Math.round((progress.acknowledged / progress.total) * 100)
    : 0;
  return (
    <div>
      <Notice
        icon={
          complete ? (
            <CircleCheck className="size-4" />
          ) : (
            <Clock className="size-4" />
          )
        }
        tone={complete ? "success" : "info"}
      >
        <p>{progressText(progress, request.revision)}</p>
        {progress.total > 0 && !complete && progress.phase !== "superseded" && (
          <div
            aria-hidden
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-info transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
        {slow && (
          <p className="text-warning-text text-xs">
            Some nodes have not acknowledged after three minutes. Nodes without
            a fresh acknowledgment may be offline or unable to reach the
            observer.
          </p>
        )}
      </Notice>
    </div>
  );
}

function validationText(error: {
  issues: { path: PropertyKey[]; message: string }[];
}) {
  return `The request is invalid: ${error.issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "profile"} ${issue.message}`
    )
    .join("; ")}.`;
}

// While a request awaits acknowledgment, refresh this scope's snapshot more
// often than the stream's throttled updates.
function useAcknowledgmentPolling(
  view: ClusterView,
  request: RequestState | undefined,
  workspace: string
) {
  const client = useQueryClient();
  const { now } = useDisplay();
  const phase = request
    ? requestProgress(view, request.revision, now).phase
    : "";
  const active =
    !!request &&
    phase !== "complete" &&
    phase !== "superseded" &&
    Date.now() - request.at < ackPatienceMs;
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(
      () => client.invalidateQueries({ queryKey: ["snapshot", workspace] }),
      ackPollMs
    );
    return () => clearInterval(timer);
  }, [active, client, workspace]);
}

export function ClusterCollection({
  view,
  workspace,
  workspaceName,
  focused,
  initialNodeUid,
}: {
  view: ClusterView;
  workspace: string;
  workspaceName: string;
  focused: boolean;
  initialNodeUid?: string;
}) {
  const client = useQueryClient();
  const card = useRef<HTMLElement>(null);
  const headingId = `cluster-${view.cluster.id}-heading`;
  const [request, setRequest] = useState<RequestState>();
  const [validation, setValidation] = useState<string>();
  const mutation = useMutation({
    mutationFn: (profile: ReturnType<typeof profileSchema.parse>) =>
      updateProfileFn({
        headers: { "X-Jood-CSRF": "1" },
        data: { clusterId: view.cluster.id, profile },
      }),
    onSuccess: (result) => {
      setRequest({ revision: result.revision, at: Date.now() });
      client.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (error) => {
      if (requestError(error).kind === "concurrent-profile") {
        client.invalidateQueries({ queryKey: ["snapshot"] });
      }
    },
  });
  useAcknowledgmentPolling(view, request, workspace);
  useEffect(() => {
    if (!focused) {
      return;
    }
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    card.current?.scrollIntoView({
      block: "start",
      behavior: reduce ? "auto" : "smooth",
    });
  }, [focused]);
  function apply(draft: ProfileDraft) {
    setValidation(undefined);
    const parsed = profileSchema.safeParse(
      profileRequest(draft, view.profile, Date.now())
    );
    if (!parsed.success) {
      setValidation(validationText(parsed.error));
      return;
    }
    mutation.mutate(parsed.data);
  }
  const { now } = useDisplay();
  const rows = nodeAcknowledgments(view, now);
  return (
    <section
      aria-labelledby={headingId}
      className="scroll-mt-20"
      id={`cluster-${view.cluster.id}`}
      ref={card}
    >
      <Card className={cn(focused && "ring-2 ring-primary/40")}>
        <ClusterHeader
          headingId={headingId}
          view={view}
          workspaceName={workspaceName}
        />
        <CardContent className="space-y-6">
          <ActiveDiagnostic view={view} />
          <ProfileForm
            initialNodeUid={initialNodeUid}
            key={`${view.cluster.id}:${view.profile.revision}`}
            onApply={apply}
            pending={mutation.isPending}
            view={view}
          />
          <div aria-live="polite">
            <RequestFeedback
              mutation={mutation}
              request={request}
              validation={validation}
              view={view}
            />
          </div>
          <div className="space-y-2">
            <h3 className="font-medium text-sm">Node acknowledgments</h3>
            <p className="text-muted-foreground text-xs">
              The observer receiving a profile and each node applying it are
              separate acknowledgments. A fresh observer heartbeat alone does
              not prove every node applied it.
            </p>
            <NodeAcknowledgments rows={rows} view={view} />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
