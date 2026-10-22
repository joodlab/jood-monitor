import type { ClusterView } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Card, CardContent, CardHeader } from "@jood-monitor/ui/card";
import { cn } from "@jood-monitor/ui/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  Clock,
  KeyRound,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { updateProfileFn } from "../functions/clusters";
import { useDisplay } from "../hooks/display";
import { minutesLeft } from "../lib/install-enrollment";
import { requestError } from "../lib/install-errors";
import { formatClock, timeZoneLabel } from "../lib/time";
import { profileSchema } from "../schemas/clusters";
import {
  type AckRequest,
  ackPatienceMs,
  activeDiagnostic,
  type DeliveryStat,
  deliveryHealth,
  effectiveProfileName,
  nodeAcknowledgments,
  type ObservationKind,
  observationFreshness,
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

function Freshness({
  value,
  label,
  kind,
}: {
  value?: string | null;
  label: string;
  kind: ObservationKind;
}) {
  const { now } = useDisplay();
  const state = observationFreshness(kind, value, now);
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

function Stat({ stat }: { stat: DeliveryStat }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-muted-foreground">{stat.term}:</dt>
      <dd
        className={cn(
          "inline-flex items-center gap-1 tabular-nums",
          stat.warn && "text-warning-text"
        )}
      >
        {stat.warn && <TriangleAlert aria-hidden className="size-3.5" />}
        {stat.value}
      </dd>
    </div>
  );
}

// Definitions sit in a disclosure rather than a hover tooltip, so touch and
// keyboard users can reach them.
function DeliveryHealth({ view }: { view: ClusterView }) {
  const { now } = useDisplay();
  const uid = useId();
  const { stats, note } = deliveryHealth(view, now);
  return (
    <div className="space-y-1.5 text-xs">
      <dl
        aria-describedby={note ? `${uid}-note` : undefined}
        className="flex flex-wrap gap-x-5 gap-y-1.5"
      >
        {stats.map((stat) => (
          <Stat key={stat.term} stat={stat} />
        ))}
      </dl>
      {note && (
        <p className="text-warning-text" id={`${uid}-note`}>
          {note}
        </p>
      )}
      <details className="group">
        <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90"
          />
          What these delivery counters mean
        </summary>
        <dl className="mt-1 space-y-1 pl-4.5">
          {stats.map((stat) => (
            <div key={stat.term}>
              <dt className="inline font-medium">{stat.term}: </dt>
              <dd className="inline text-muted-foreground">
                {stat.definition}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
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
  const { now } = useDisplay();
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
          <Badge variant="outline">
            {profileLabel(effectiveProfileName(profile, now))} profile
          </Badge>
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
              kind="heartbeat"
              label="Last heartbeat received by the hub"
              value={cluster.heartbeatAt}
            />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Inventory</dt>
          <dd className="flex flex-wrap gap-x-1.5">
            <Freshness
              kind="inventory"
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
        profile and apply to end it early. Other changes keep this end time
        unless you restart the window.
      </p>
    </Notice>
  );
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
  request?: AckRequest;
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

// The settings page holds each card's request, so one page-wide poller can
// refresh acknowledgments for every card.
export function ClusterCollection({
  view,
  workspaceName,
  focused,
  initialNodeUid,
  request,
  onRequest,
}: {
  view: ClusterView;
  workspaceName: string;
  focused: boolean;
  initialNodeUid?: string;
  request?: AckRequest;
  onRequest: (request: AckRequest) => void;
}) {
  const client = useQueryClient();
  const { now } = useDisplay();
  const card = useRef<HTMLElement>(null);
  const headingId = `cluster-${view.cluster.id}-heading`;
  const [validation, setValidation] = useState<string>();
  const mutation = useMutation({
    mutationFn: (profile: ReturnType<typeof profileSchema.parse>) =>
      updateProfileFn({
        headers: { "X-Jood-CSRF": "1" },
        data: { clusterId: view.cluster.id, profile },
      }),
    onSuccess: (result) => {
      onRequest({ revision: result.revision, at: Date.now() });
      client.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (error) => {
      if (requestError(error).kind === "concurrent-profile") {
        client.invalidateQueries({ queryKey: ["snapshot"] });
      }
    },
  });
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
  const rows = nodeAcknowledgments(view, now);
  // A new revision or an ended diagnostic resets the draft, so a form touched
  // before expiry cannot silently re-arm the diagnostic.
  const formKey = `${view.cluster.id}:${view.profile.revision}:${effectiveProfileName(view.profile, now)}`;
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
            key={formKey}
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
