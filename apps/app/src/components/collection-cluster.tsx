import type { ClusterView } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import { cn } from "@jood-monitor/ui/utils";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  Clock,
  Gauge,
  Info,
  KeyRound,
  Layers,
  ListChecks,
  RadioTower,
  RefreshCw,
  Server,
  Stethoscope,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useDeliveryWatch } from "../hooks/delivery";
import { useDisplay } from "../hooks/display";
import { heartbeatKnown, withCapturedHeartbeat } from "../lib/collection-state";
import { minutesLeft } from "../lib/install-enrollment";
import {
  awaitingSnapshot,
  dismissCleared,
  draftFor,
  stageDraft,
  stagedDraftFor,
  stagedFields,
  useStagedState,
} from "../lib/staged-changes";
import { formatClock, timeZoneLabel } from "../lib/time";
import {
  type AckRequest,
  ackPatienceMs,
  activeDiagnostic,
  capabilityLabel,
  clusterNodes,
  type DeliveryStat,
  type DraftField,
  deliveryHealth,
  diagnosticMinutes,
  draftFieldProblems,
  effectiveProfileName,
  knownNamespaces,
  nodeAcknowledgments,
  nodeNamer,
  type ObservationKind,
  observationFreshness,
  type ProfileDraft,
  profileChoices,
  profileLabel,
  progressText,
  requestProgress,
} from "./collection-model";
import { NamespaceField } from "./collection-namespaces";
import { NodeAcknowledgments } from "./collection-nodes";
import { DocLink, Notice } from "./connect-parts";
import { RenewalHint } from "./connect-recover";
import { EnrollForm } from "./enroll-form";
import { HubBuffer } from "./hub-buffer";
import { DiagnosticOptions, PauseField, ProfileChoices } from "./profile-form";
import { SettingsRail, StagedPill } from "./settings-rail";
import { TimeText } from "./time";

type Cluster = ClusterView["cluster"];

// Full-strength focus ring; it replaces the Button primitive's softer halo.
const focusRing = "focus-visible:ring-2 focus-visible:ring-ring";

// `at` judges the time at another moment than the display clock (a saved
// observation's inventory receipt); `absolute` shows the exact time.
export function Freshness({
  value,
  label,
  kind,
  at,
  absolute = false,
}: {
  value?: string | null;
  label: string;
  kind: ObservationKind;
  at?: number;
  absolute?: boolean;
}) {
  const { now } = useDisplay();
  const state = observationFreshness(kind, value, at ?? now);
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
      <TimeText absolute={absolute} label={label} value={value} />
      {!fresh && <span>· {state}</span>}
    </span>
  );
}

// Warnings carry a triangle, totals worth noticing an info mark; the icon
// and the words carry the state, the colour only reinforces it.
function Stat({ stat }: { stat: DeliveryStat }) {
  return (
    <div className="flex items-start gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{stat.term}:</dt>
      <dd
        className={cn(
          "inline-flex min-w-0 items-start gap-1 tabular-nums",
          stat.tone === "warn" && "text-warning-text",
          stat.tone === "notice" && "text-foreground"
        )}
      >
        {stat.tone === "warn" && (
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
        )}
        {stat.tone === "notice" && (
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
        )}
        <span className="min-w-0">{stat.value}</span>
      </dd>
    </div>
  );
}

// Definitions sit in a disclosure rather than a hover tooltip, so touch and
// keyboard users can reach them. Live, the counters say what this page has
// seen them do; `absolute` reads a saved observation's counters as captured,
// judged at `at` (its inventory's receipt).
export function DeliveryHealth({
  view,
  at,
  absolute = false,
}: {
  view: ClusterView;
  at?: number;
  absolute?: boolean;
}) {
  const { now, timeZone } = useDisplay();
  const uid = useId();
  const views = useMemo(() => [view], [view]);
  const watches = useDeliveryWatch(views);
  const { stats, note } = absolute
    ? deliveryHealth(withCapturedHeartbeat(view), at ?? now, {
        captured: heartbeatKnown(view, true),
        timeZone,
      })
    : deliveryHealth(view, at ?? now, {
        timeZone,
        watch: watches.get(view.cluster.id),
      });
  return (
    <div className="space-y-1.5 text-xs">
      <dl
        aria-describedby={note ? `${uid}-note` : undefined}
        className="grid gap-y-1.5"
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
      <p className="text-muted-foreground">
        Dropped batches and rejected points are running totals since the
        observer started; the observer does not report when they happened.
      </p>
      <details className="group">
        <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
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

export function Capabilities({ view }: { view: ClusterView }) {
  const capabilities = view.heartbeat.capabilities ?? [];
  if (!capabilities.length) {
    return (
      <p className="text-muted-foreground text-xs">
        Not reported yet. Sources appear once the observer sends a heartbeat.
      </p>
    );
  }
  return (
    <ul aria-label="Reported sources" className="flex flex-wrap gap-1.5">
      {capabilities.map((capability) => (
        <li key={capability}>
          <Badge
            variant={
              capability.endsWith("_unavailable") ? "warning" : "outline"
            }
          >
            {capability.endsWith("_unavailable") && (
              <TriangleAlert aria-hidden />
            )}
            {capabilityLabel(capability)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function ObserverRail({ view }: { view: ClusterView }) {
  const { cluster, heartbeat } = view;
  return (
    <SettingsRail
      description="The observer in this cluster: what it runs, when the hub last heard from it, and whether its telemetry is getting through."
      icon={RadioTower}
      title="Observer"
    >
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div className="min-w-0 space-y-0.5">
          <dt className="text-muted-foreground text-xs">Version</dt>
          {/* Builds report a full commit hash; wrap it rather than shorten it. */}
          <dd className="break-all font-mono text-xs">
            {heartbeat.version || "Not reported"}
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-muted-foreground text-xs">Heartbeat</dt>
          <dd className="text-xs">
            <Freshness
              kind="heartbeat"
              label="Last heartbeat received by the hub"
              value={cluster.heartbeatAt}
            />
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-muted-foreground text-xs">Inventory</dt>
          <dd className="flex flex-wrap gap-x-1.5 text-xs">
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
      <div className="space-y-1.5">
        <p className="font-medium text-sm">Delivery health</p>
        <DeliveryHealth view={view} />
      </div>
      <HubBuffer cluster={cluster} />
      <div className="space-y-1.5">
        <p className="font-medium text-sm">Reported sources</p>
        <Capabilities view={view} />
      </div>
    </SettingsRail>
  );
}

function ActiveDiagnostic({ view }: { view: ClusterView }) {
  const { now, timeZone } = useDisplay();
  const diagnostic = activeDiagnostic(view.profile, now);
  if (!diagnostic) {
    return null;
  }
  const names = diagnostic.nodeUids.map(nodeNamer(view));
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
        returns to {profileChoices[diagnostic.returnTo].label}. Stage another
        profile and apply to end it early. Other changes keep this end time
        unless you restart the window.
      </p>
    </Notice>
  );
}

function Problems({ problems }: { problems: string[] }) {
  if (!problems.length) {
    return null;
  }
  return (
    <ul aria-live="polite" className="space-y-1 text-warning-text text-xs">
      {problems.map((problem) => (
        <li className="flex items-start gap-1.5" key={problem}>
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {problem}
        </li>
      ))}
    </ul>
  );
}

function RequestFeedback({
  view,
  request,
  applying,
  failure,
}: {
  view: ClusterView;
  request?: AckRequest;
  applying: boolean;
  failure?: string;
}) {
  const { now } = useDisplay();
  if (failure) {
    return (
      <Notice
        icon={<CircleAlert className="size-4" />}
        role="alert"
        tone="destructive"
      >
        <p>{failure}</p>
        <p className="text-xs">Your changes are still staged.</p>
      </Notice>
    );
  }
  if (applying) {
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
          Some nodes have not acknowledged after three minutes. Nodes without a
          fresh acknowledgment may be offline or unable to reach the observer.
        </p>
      )}
    </Notice>
  );
}

function EnrollmentRail({
  cluster,
  clusters,
}: {
  cluster: Cluster;
  clusters: Cluster[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRail
      badge={
        cluster.revoked && (
          <Badge variant="destructive">
            <KeyRound aria-hidden />
            Credential revoked
          </Badge>
        )
      }
      description="Renewal issues a new one-time token for this cluster ID. History, workspace and collection settings stay intact."
      icon={KeyRound}
      last
      title="Enrollment"
    >
      <RenewalHint cluster={cluster} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          className={focusRing}
          onClick={() => setOpen(true)}
          size="sm"
          variant="outline"
        >
          <RefreshCw />
          Renew enrollment
        </Button>
        <DocLink href="/docs/agents#revoke-credential">
          Revoke an active credential
        </DocLink>
      </div>
      <p className="text-muted-foreground text-xs">
        Renewal never revokes or rotates credentials. A cluster with an active
        credential must have it revoked first.
      </p>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Renew enrollment for {cluster.name}</DialogTitle>
            <DialogDescription>
              Issue a one-time token, install the observer with it, and confirm
              the first heartbeat.
            </DialogDescription>
          </DialogHeader>
          <EnrollForm
            clusters={clusters}
            renew={cluster}
            workspace={cluster.workspaceId}
          />
        </DialogContent>
      </Dialog>
    </SettingsRail>
  );
}

function ClusterHeading({
  view,
  workspaceName,
  staged,
}: {
  view: ClusterView;
  workspaceName: string;
  staged: number;
}) {
  const { cluster, profile } = view;
  const { now } = useDisplay();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-card text-muted-foreground"
        >
          <Server className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-xl tracking-tight">
            {cluster.name}
          </h2>
          <p className="text-muted-foreground text-xs">
            <span className="font-mono">{cluster.id}</span> ·{" "}
            {cluster.environment || "No environment"} · {workspaceName}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
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
        {staged > 0 && (
          <StagedPill>
            {staged} staged change{staged === 1 ? "" : "s"}
          </StagedPill>
        )}
      </div>
    </div>
  );
}

function ClearedNotice({ clusterId }: { clusterId: string }) {
  const staged = useStagedState();
  const message = staged.cleared[clusterId];
  if (!message) {
    return null;
  }
  return (
    <Notice icon={<Info className="size-4" />} role="status" tone="info">
      <p>{message}</p>
      <Button
        className={cn("h-8", focusRing)}
        onClick={() => dismissCleared(clusterId)}
        size="sm"
        variant="outline"
      >
        Dismiss
      </Button>
    </Notice>
  );
}

function DiagnosticStarter({
  view,
  node,
  disabled,
  onStage,
}: {
  view: ClusterView;
  node: string;
  disabled: boolean;
  onStage: () => void;
}) {
  const nodes = clusterNodes(view);
  const name = nodes.some((item) => item.uid === node)
    ? nodeNamer(view)(node)
    : undefined;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3">
      <p className="min-w-0 flex-1 text-muted-foreground text-xs">
        {nodes.length
          ? `Samples selected host sources every 5 s on one node for ${diagnosticMinutes} minutes, then returns to the current profile. Host CPU and memory are charted in that node's Metrics tab; network, disk and filesystem samples are stored and available through the history API but not yet charted.`
          : "Diagnostics need a node in the cluster inventory. Wait for the observer to report nodes."}
      </p>
      <Button
        className={focusRing}
        disabled={disabled || !nodes.length}
        onClick={onStage}
        size="sm"
        variant="outline"
      >
        <Stethoscope />
        {name ? `Stage a diagnostic on ${name}` : "Stage a diagnostic"}
      </Button>
    </div>
  );
}

// The inspector asked for a node the diagnostic does not run on. Moving it
// ends the current window and starts a new one, so it is an explicit staged
// change, never the form's starting point.
function MoveDiagnostic({
  view,
  draft,
  requested,
  disabled,
  onMove,
}: {
  view: ClusterView;
  draft: ProfileDraft;
  requested?: string;
  disabled: boolean;
  onMove: (node: string) => void;
}) {
  const { now } = useDisplay();
  const running = activeDiagnostic(view.profile, now);
  const known = clusterNodes(view).some((node) => node.uid === requested);
  if (
    !(running && requested && known) ||
    draft.name !== "diagnostic" ||
    draft.node === requested ||
    running.nodeUids.includes(requested)
  ) {
    return null;
  }
  const namer = nodeNamer(view);
  const name = namer(requested);
  const current = running.nodeUids.map(namer).join(", ") || "another node";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3">
      <p className="min-w-0 flex-1 text-muted-foreground text-xs">
        The diagnostic runs on {current} now. Moving it to {name} ends that
        window and runs {diagnosticMinutes} minutes on {name} after you apply.
      </p>
      <Button
        className={focusRing}
        disabled={disabled}
        onClick={() => onMove(requested)}
        size="sm"
        variant="outline"
      >
        <Stethoscope />
        Move the diagnostic to {name}
      </Button>
    </div>
  );
}

const noFields: ReadonlySet<DraftField> = new Set();

// One cluster's settings as Railway-style rails. Edits are staged in the
// shared store and applied from the staged-changes card; this panel shows
// what is staged, what is in effect, and acknowledgment progress.
export function ClusterSettings({
  view,
  workspaceName,
  initialNodeUid,
  clusters,
}: {
  view: ClusterView;
  workspaceName: string;
  initialNodeUid?: string;
  clusters: Cluster[];
}) {
  const { now } = useDisplay();
  const staged = useStagedState();
  const id = view.cluster.id;
  const draft = draftFor(staged, view, now, initialNodeUid);
  const entry = stagedDraftFor(staged, view, now);
  // Staged indicators come from the store only, so pills and the heading
  // count always match the Apply card.
  const fields = entry ? stagedFields(entry, view.profile, now) : noFields;
  const nodes = clusterNodes(view);
  const problems = entry
    ? draftFieldProblems(draft, nodes, view.profile, now)
    : { profile: [], namespaces: [] };
  const applying = !!staged.applying[id];
  // Sending, or accepted while the snapshot still shows the old profile:
  // edits now would be staged against the revision being replaced.
  const locked = awaitingSnapshot(staged, view);
  const update = (patch: Partial<ProfileDraft>) =>
    stageDraft(view, { ...draft, ...patch }, now);
  const inventory = new Set(
    view.inventory.entities.flatMap((entity) => {
      if (entity.kind === "Namespace") {
        return [entity.name];
      }
      return entity.namespace ? [entity.namespace] : [];
    })
  );
  const profileStaged = fields.has("profile");
  return (
    <div className="space-y-4">
      <ClusterHeading
        staged={fields.size}
        view={view}
        workspaceName={workspaceName}
      />
      <ClearedNotice clusterId={id} />
      <div className="rounded-xl border bg-card p-4 sm:p-6">
        <ObserverRail view={view} />
        <SettingsRail
          badge={profileStaged && <StagedPill />}
          description="How much the observer and node collectors sample. Changes are staged until you apply them."
          icon={Gauge}
          title="Collection profile"
        >
          <ProfileChoices
            disabled={locked}
            onChange={(name) => update({ name })}
            profile={view.profile}
            staged={profileStaged}
            value={draft.name}
          />
        </SettingsRail>
        <SettingsRail
          badge={profileStaged && draft.name === "diagnostic" && <StagedPill />}
          description={`A bounded, high-resolution window on one node. It expires ${diagnosticMinutes} minutes after applying, even if the hub is unreachable.`}
          icon={Stethoscope}
          title="Diagnostics"
        >
          <ActiveDiagnostic view={view} />
          <MoveDiagnostic
            disabled={locked}
            draft={draft}
            onMove={(node) => update({ node })}
            requested={initialNodeUid}
            view={view}
          />
          {draft.name === "diagnostic" ? (
            <DiagnosticOptions
              disabled={locked}
              extend={draft.extend}
              nodes={nodes}
              onChange={(node) => update({ node })}
              onExtendChange={(extend) => update({ extend })}
              profile={view.profile}
              staged={profileStaged}
              value={draft.node}
            />
          ) : (
            <DiagnosticStarter
              disabled={locked}
              node={draft.node}
              onStage={() => update({ name: "diagnostic" })}
              view={view}
            />
          )}
          <Problems problems={problems.profile} />
        </SettingsRail>
        <SettingsRail
          badge={fields.has("namespaces") && <StagedPill />}
          description="Limits pod and container usage metrics to chosen namespaces. Node metrics and inventory are unaffected."
          icon={Layers}
          title="Pod metrics namespaces"
        >
          <NamespaceField
            current={view.profile.namespaces}
            disabled={locked}
            draft={draft}
            inventory={inventory}
            known={knownNamespaces(view)}
            onChange={update}
          />
          <Problems problems={problems.namespaces} />
        </SettingsRail>
        <SettingsRail
          badge={fields.has("paused") && <StagedPill />}
          description="Stop new samples without losing history. Applying a pause asks for confirmation."
          icon={CirclePause}
          title="Pause"
        >
          <PauseField
            checked={draft.paused}
            current={view.profile.paused}
            disabled={locked}
            onChange={(paused) => update({ paused })}
            staged={fields.has("paused")}
          />
        </SettingsRail>
        <SettingsRail
          description="The observer receiving a profile and each node applying it are separate acknowledgments. A fresh observer heartbeat alone does not prove every node applied it."
          icon={ListChecks}
          title="Node acknowledgments"
        >
          <div aria-live="polite">
            <RequestFeedback
              applying={applying}
              failure={staged.failures[id]}
              request={staged.requests[id]}
              view={view}
            />
          </div>
          <NodeAcknowledgments
            rows={nodeAcknowledgments(view, now)}
            view={view}
          />
        </SettingsRail>
        <EnrollmentRail cluster={view.cluster} clusters={clusters} />
      </div>
    </div>
  );
}
