import type { ClusterView } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@jood-monitor/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@jood-monitor/ui/table";
import { cn } from "@jood-monitor/ui/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Clock,
  EllipsisVertical,
  Gauge,
  Info,
  Layers,
  type LucideIcon,
  Server,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { updateProfileFn } from "../functions/clusters";
import { fetchSnapshot } from "../hooks/api/clusters";
import { useDisplay } from "../hooks/display";
import {
  applyStagedClusters,
  discardStaged,
  dismissRequests,
  type Elsewhere,
  pausingClusters,
  pruneStaged,
  type RecentRequest,
  revertField,
  type StagedCluster,
  type StagedRow,
  type StagedScope,
  settleRequests,
  shownClusterIds,
  stageDraft,
  stagedCount,
  stagedScope,
  stagedWaiting,
  useStagedState,
} from "../lib/staged-changes";
import { inspectorReset, scopeReset } from "../schemas/monitor";
import type { AckRequest, DraftField } from "./collection-model";
import {
  ackPatienceMs,
  ackPollDelay,
  latestPendingRequest,
  progressSummary,
} from "./collection-model";

// Railway-style staged changes: collection edits wait as a floating
// "Apply N changes" card with a diff dialog. Applying sends each cluster's
// profile through the existing CSRF-protected mutation, then reports node
// acknowledgments. Mounted on the canvas and Settings; whichever mounts it
// runs the single acknowledgment poller.

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const cardBase =
  "w-72 max-w-[calc(100vw-2rem)] space-y-1 rounded-xl border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur-sm";

// Full-strength focus ring; it replaces the Button primitive's softer halo.
const focusRing = "focus-visible:ring-2 focus-visible:ring-ring";

// Apply keeps focus while it is disabled during the request, so keyboard
// users are not dropped to the page; it still looks and acts disabled.
const keepFocus = cn(
  focusRing,
  "aria-disabled:pointer-events-none aria-disabled:opacity-50"
);

// A card heading that takes focus when the control that held it unmounts.
const headingFocus = cn("rounded-sm outline-none", focusRing);

const noViews: ClusterView[] = [];

const noScope: StagedScope = {
  clusters: [],
  discard: [],
  elsewhere: { staged: 0, unconfirmed: 0 },
  recent: [],
};

// The live snapshot the dashboard already keeps fresh. This reader adds no
// schedule of its own; with `load` it fetches only when nothing is cached
// yet. Without it (frozen views, or a reader mounted beside the dashboard's
// own query, whose retry policy must decide the first fetch) it only reads,
// keeping what was cached.
export function useLiveSnapshot(scope: string, load: boolean) {
  const snapshot = useQuery({
    queryKey: ["snapshot", scope, "live"],
    queryFn: () => fetchSnapshot(scope),
    enabled: load,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  return snapshot.data?.clusters;
}

// While any request awaits acknowledgment, the live snapshot is refreshed at
// fixed marks after the latest request (10 s, 30 s, then every 30 s) until
// the patience window ends. The schedule depends only on the time since the
// request, so remounting (a namespace drill, a tab switch) keeps it. Hidden
// tabs skip refreshes; the query refetches on focus. A slow scope-wide fetch
// is not cancelled by the next tick.
function useAcknowledgmentPolling(
  views: ClusterView[],
  requests: Partial<Record<string, AckRequest>>,
  scope: string,
  live: boolean
) {
  const client = useQueryClient();
  const { now } = useDisplay();
  const since = live ? latestPendingRequest(views, requests, now) : undefined;
  useEffect(() => {
    if (since === undefined) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delay = ackPollDelay(Date.now() - since);
      timer = delay === undefined ? undefined : setTimeout(tick, delay);
    };
    const tick = () => {
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

type ProfileSend = Parameters<typeof applyStagedClusters>[1];

const sendProfile: ProfileSend = (clusterId, profile) =>
  updateProfileFn({
    headers: { "X-Jood-CSRF": "1" },
    data: { clusterId, profile },
  });

// Sends each staged cluster's profile. A failure keeps that cluster's
// changes staged with the reason; the others still apply. Each accepted
// cluster refreshes the snapshot right away, so its settings unlock when its
// own revision lands rather than after the slowest cluster.
function useApplyStaged() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (targets: StagedCluster[]) =>
      applyStagedClusters(targets, sendProfile, () =>
        client.invalidateQueries(
          { queryKey: ["snapshot"] },
          { cancelRefetch: false }
        )
      ),
    onSettled: () =>
      client.invalidateQueries(
        { queryKey: ["snapshot"] },
        { cancelRefetch: false }
      ),
  });
}

type FinalFocus = () => HTMLElement | boolean;

function PauseConfirm({
  targets,
  finalFocus,
  onCancel,
  onConfirm,
}: {
  targets: StagedCluster[];
  finalFocus: FinalFocus;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const pausing = pausingClusters(targets);
  const only = pausing.length === 1 ? pausing[0] : undefined;
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      open={pausing.length > 0}
    >
      <DialogContent finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            {only
              ? `Pause collection for ${only.view.cluster.name}?`
              : `Pause collection for ${pausing.length} clusters?`}
          </DialogTitle>
          <DialogDescription>
            New metric samples stop on the observer and every node collector
            until you resume. Charts show a gap for this period; missing samples
            are never shown as zero. Inventory, heartbeats and stored history
            are kept.
          </DialogDescription>
        </DialogHeader>
        {!only && (
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {pausing.map((cluster) => (
              <li key={cluster.view.cluster.id}>{cluster.view.cluster.name}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button className={focusRing} onClick={onCancel} variant="outline">
            Keep collecting
          </Button>
          <Button className={focusRing} onClick={onConfirm} variant="warning">
            Pause and apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const fieldIcons: Record<DraftField, LucideIcon> = {
  profile: Gauge,
  namespaces: Layers,
  paused: CirclePause,
};

function ChangeRow({
  row,
  cluster,
  disabled,
}: {
  row: StagedRow;
  cluster: StagedCluster;
  disabled: boolean;
}) {
  const { now } = useDisplay();
  const Icon = fieldIcons[row.field];
  const { view, draft } = cluster;
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="whitespace-normal align-top">
        <span className="flex items-center gap-2 font-medium text-staged-text">
          <Icon aria-hidden className="size-4 shrink-0" />
          {row.label}
        </span>
      </TableCell>
      <TableCell className="whitespace-normal align-top">
        <span className="block rounded-md bg-muted/60 px-2 py-1.5 text-xs">
          {row.current}
        </span>
      </TableCell>
      <TableCell className="whitespace-normal align-top">
        <span className="block rounded-md bg-staged/15 px-2 py-1.5 text-staged-text text-xs">
          {row.next}
        </span>
      </TableCell>
      <TableCell className="w-10 align-top">
        <Button
          aria-label={`Discard the ${row.label.toLowerCase()} change for ${view.cluster.name}`}
          className={focusRing}
          disabled={disabled}
          onClick={() =>
            stageDraft(
              view,
              revertField(draft, view.profile, row.field, now),
              now
            )
          }
          size="icon-sm"
          variant="ghost"
        >
          <X />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function GroupMessages({ cluster }: { cluster: StagedCluster }) {
  if (!(cluster.problems.length || cluster.failure)) {
    return null;
  }
  return (
    <div className="space-y-1.5 border-t px-3 py-2 text-xs">
      {cluster.problems.map((problem) => (
        <p className="flex items-start gap-1.5 text-warning-text" key={problem}>
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {problem}
        </p>
      ))}
      {cluster.failure && (
        <p
          className="flex items-start gap-1.5 text-destructive-text"
          role="alert"
        >
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          Not applied: {cluster.failure}
        </p>
      )}
    </div>
  );
}

function ClusterGroup({
  cluster,
  disabled,
}: {
  cluster: StagedCluster;
  disabled: boolean;
}) {
  const uid = useId();
  const [open, setOpen] = useState(true);
  const { view, rows } = cluster;
  const name = view.cluster.name;
  return (
    <section aria-labelledby={`${uid}-title`} className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <button
          aria-controls={`${uid}-body`}
          aria-expanded={open}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          <Server
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate" id={`${uid}-title`}>
            <span className="font-medium text-staged-text">{name}</span>{" "}
            <span className="text-muted-foreground">will change</span>
          </span>
        </button>
        <span className="text-muted-foreground text-xs tabular-nums">
          {plural(rows.length, "setting")}
        </span>
        <Button
          aria-label={`Discard staged changes for ${name}`}
          className={focusRing}
          disabled={disabled}
          onClick={() => discardStaged([view.cluster.id])}
          size="sm"
          variant="outline"
        >
          Discard
        </Button>
      </div>
      {open && (
        <div className="border-t" id={`${uid}-body`}>
          <Table>
            <TableCaption className="sr-only">
              Staged changes for {name}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground text-xs">
                  Change
                </TableHead>
                <TableHead className="text-muted-foreground text-xs">
                  Current value
                </TableHead>
                <TableHead className="text-muted-foreground text-xs">
                  New value
                </TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Discard</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ChangeRow
                  cluster={cluster}
                  disabled={disabled}
                  key={row.field}
                  row={row}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <GroupMessages cluster={cluster} />
    </section>
  );
}

function Consequences({ clusters }: { clusters: StagedCluster[] }) {
  const named = clusters.length > 1;
  const notes = clusters.flatMap((cluster) =>
    cluster.notes.map((note) =>
      named ? `${cluster.view.cluster.name}: ${note}` : note
    )
  );
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2 text-muted-foreground text-xs">
      <Info aria-hidden className="mt-px size-4 shrink-0" />
      <div className="space-y-1">
        {notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        <p>
          Each observer picks up its new revision within about 15 seconds; every
          node acknowledges separately.
        </p>
      </div>
    </div>
  );
}

function StagedDetails({
  open,
  clusters,
  applying,
  finalFocus,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  clusters: StagedCluster[];
  applying: boolean;
  finalFocus: FinalFocus;
  onOpenChange: (open: boolean) => void;
  onApply: () => void;
}) {
  const count = stagedCount(clusters);
  const blocked = clusters.filter((cluster) => cluster.problems.length > 0);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-0 p-0 sm:max-w-3xl" finalFocus={finalFocus}>
        <DialogHeader className="border-b px-6 py-4 pr-14">
          <DialogTitle className="font-semibold text-lg">
            {plural(count, "change")} to apply
          </DialogTitle>
          <DialogDescription>
            Staged collection settings, not applied yet. Each change shows the
            value in effect now and the value it will request.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(60vh,36rem)] space-y-3 overflow-y-auto px-6 py-4">
          {clusters.map((cluster) => (
            <ClusterGroup
              cluster={cluster}
              disabled={applying}
              key={cluster.view.cluster.id}
            />
          ))}
        </div>
        <DialogFooter className="items-start gap-3 border-t px-6 py-4 sm:items-center sm:justify-between">
          <Consequences clusters={clusters} />
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button
              className={keepFocus}
              disabled={applying || blocked.length > 0}
              focusableWhenDisabled
              onClick={onApply}
            >
              <Check />
              {applying ? "Applying…" : "Apply changes"}
            </Button>
            {blocked.length > 0 && (
              <span className="text-warning-text text-xs">
                Fix the {plural(blocked.length, "cluster")} marked above first.
              </span>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StagedStatus({ clusters }: { clusters: StagedCluster[] }) {
  const blocked = clusters.filter((cluster) => cluster.problems.length > 0);
  const failed = clusters.filter((cluster) => cluster.failure);
  return (
    <>
      <p className="text-muted-foreground text-xs">
        {clusters.length === 1
          ? `For ${clusters[0]?.view.cluster.name}`
          : `For ${clusters.length} clusters`}{" "}
        · not applied yet
      </p>
      {blocked.length > 0 && (
        <p className="flex items-start gap-1.5 text-warning-text text-xs">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {blocked.length === 1
            ? "One cluster needs a fix before applying."
            : `${blocked.length} clusters need a fix before applying.`}
        </p>
      )}
      {failed.length > 0 && (
        <p
          className="flex items-start gap-1.5 text-destructive-text text-xs"
          role="alert"
        >
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          Not applied to{" "}
          {failed.map((cluster) => cluster.view.cluster.name).join(", ")}. See
          Details.
        </p>
      )}
    </>
  );
}

type HeadingRef = RefObject<HTMLParagraphElement | null>;

function hasElsewhere(elsewhere: Elsewhere) {
  return elsewhere.staged > 0 || elsewhere.unconfirmed > 0;
}

function elsewhereText({ staged, unconfirmed }: Elsewhere) {
  const parts = [
    staged > 0 && `${plural(staged, "change")} staged`,
    unconfirmed > 0 &&
      `${unconfirmed} unconfirmed change${unconfirmed === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return `${parts.join(" and ")} for other clusters`;
}

// Drafts and unconfirmed requests the top bar's cluster filter hides. The
// card never applies, discards or drops them out of sight, so it says they
// exist and offers the way back. Without a card of its own to head, the line
// takes focus as the heading.
function OtherClusters({
  elsewhere,
  heading,
  onShowAll,
}: {
  elsewhere: Elsewhere;
  heading?: HeadingRef;
  onShowAll: () => void;
}) {
  if (!hasElsewhere(elsewhere)) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-2 gap-y-1",
        !heading && "mt-2 border-t pt-2"
      )}
    >
      <p
        className={cn("text-muted-foreground text-xs", heading && headingFocus)}
        ref={heading}
        tabIndex={heading ? -1 : undefined}
      >
        {elsewhereText(elsewhere)}
      </p>
      <Button
        className={focusRing}
        onClick={onShowAll}
        size="sm"
        variant="ghost"
      >
        Show all clusters
      </Button>
    </div>
  );
}

function StagedCard({
  className,
  clusters,
  applying,
  elsewhere,
  heading,
  onApply,
  onDetails,
  onDiscardAll,
  onShowAll,
}: {
  className?: string;
  clusters: StagedCluster[];
  applying: boolean;
  elsewhere: Elsewhere;
  heading: HeadingRef;
  onApply: () => void;
  onDetails: () => void;
  onDiscardAll: () => void;
  onShowAll: () => void;
}) {
  const count = stagedCount(clusters);
  // Discarding never reaches the hidden clusters, so the menu names the ones
  // it does: the filtered cluster, and on Settings one a link opened.
  const shownOnly =
    elsewhere.staged > 0
      ? clusters.map((cluster) => cluster.view.cluster.name).join(" and ")
      : undefined;
  return (
    <section
      aria-label="Staged changes"
      className={cn(cardBase, "border-staged/40", className)}
    >
      <p
        className={cn("font-medium text-sm text-staged-text", headingFocus)}
        ref={heading}
        tabIndex={-1}
      >
        {applying
          ? `Applying ${plural(count, "change")}…`
          : `Apply ${plural(count, "change")}`}
      </p>
      <StagedStatus clusters={clusters} />
      <div className="flex items-center gap-2 pt-2">
        <Button
          className={focusRing}
          onClick={onDetails}
          size="sm"
          variant="outline"
        >
          Details
        </Button>
        <Button
          className={keepFocus}
          disabled={applying}
          focusableWhenDisabled
          onClick={onApply}
          size="sm"
        >
          Apply
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="More staged change actions"
                className={cn("ml-auto", focusRing)}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <EllipsisVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={applying}
              onClick={onDiscardAll}
              variant="destructive"
            >
              <Trash2 />
              {shownOnly
                ? `Discard changes for ${shownOnly}`
                : "Discard all changes"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <OtherClusters elsewhere={elsewhere} onShowAll={onShowAll} />
    </section>
  );
}

// Nothing staged or settling for the filtered cluster, but others have some.
function ElsewhereCard({
  className,
  elsewhere,
  heading,
  onShowAll,
}: {
  className?: string;
  elsewhere: Elsewhere;
  heading: HeadingRef;
  onShowAll: () => void;
}) {
  return (
    <section aria-label="Staged changes" className={cn(cardBase, className)}>
      <OtherClusters
        elsewhere={elsewhere}
        heading={heading}
        onShowAll={onShowAll}
      />
    </section>
  );
}

const patienceText = `${ackPatienceMs / 60_000} minutes`;

// The card heading: an unconfirmed request outranks the others, and success
// is only claimed when every request is fully acknowledged.
function progressHeading(recent: RecentRequest[]) {
  if (recent.some((item) => item.timedOut)) {
    return {
      Icon: TriangleAlert,
      tone: "text-warning-text",
      text: `Not all nodes acknowledged after ${patienceText}`,
    };
  }
  if (recent.every((item) => item.progress?.phase === "complete")) {
    return {
      Icon: CircleCheck,
      tone: "text-success-text",
      text: "Collection changes applied",
    };
  }
  return {
    Icon: Clock,
    tone: "text-info-text",
    text: "Applying collection changes",
  };
}

function recentSummary(item: RecentRequest) {
  if (!item.progress) {
    return "Sending to the hub…";
  }
  const summary = progressSummary(item.progress);
  // The stale-observer summary already says it is unconfirmed.
  return item.timedOut && item.progress.phase !== "observer-stale"
    ? `${summary} (unconfirmed)`
    : summary;
}

function ProgressCard({
  className,
  elsewhere,
  recent,
  heading,
  onSettings,
  onShowAll,
}: {
  className?: string;
  elsewhere: Elsewhere;
  recent: RecentRequest[];
  heading: HeadingRef;
  onSettings?: (clusterId?: string) => void;
  onShowAll: () => void;
}) {
  const { Icon, tone, text } = progressHeading(recent);
  const timedOut = recent.filter((item) => item.timedOut);
  return (
    <section
      aria-label="Collection changes"
      className={cn(
        cardBase,
        timedOut.length > 0 && "border-warning/40",
        className
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5 font-medium text-sm",
          headingFocus
        )}
        ref={heading}
        tabIndex={-1}
      >
        <Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
        {text}
      </p>
      <ul className="space-y-0.5 text-xs">
        {recent.map((item) => (
          <li key={item.view.cluster.id}>
            <span className="font-medium">{item.view.cluster.name}</span>
            <span className="text-muted-foreground">
              {" "}
              · {recentSummary(item)}
            </span>
          </li>
        ))}
      </ul>
      {(onSettings || timedOut.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {onSettings && (
            <Button
              className={focusRing}
              onClick={() =>
                onSettings(
                  recent.length === 1 ? recent[0]?.view.cluster.id : undefined
                )
              }
              size="sm"
              variant="outline"
            >
              View acknowledgments
            </Button>
          )}
          {timedOut.length > 0 && (
            <Button
              aria-label={
                timedOut.length === 1
                  ? `Dismiss the unconfirmed change for ${timedOut[0]?.view.cluster.name}`
                  : `Dismiss ${timedOut.length} unconfirmed changes`
              }
              className={focusRing}
              onClick={() =>
                dismissRequests(timedOut.map((item) => item.view.cluster.id))
              }
              size="sm"
              variant="ghost"
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
      <OtherClusters elsewhere={elsewhere} onShowAll={onShowAll} />
    </section>
  );
}

function FrozenCard({
  className,
  heading,
  onLive,
}: {
  className?: string;
  heading: HeadingRef;
  onLive: () => void;
}) {
  return (
    <section
      aria-label="Staged changes"
      className={cn(cardBase, "border-staged/40", className)}
    >
      <p
        className={cn("font-medium text-sm text-staged-text", headingFocus)}
        ref={heading}
        tabIndex={-1}
      >
        Staged changes are waiting
      </p>
      <p className="text-muted-foreground text-xs">
        Reviewing and applying collection changes is only available live. They
        stay staged in this tab until you reload or close it.
      </p>
      <div className="pt-2">
        <Button
          className={focusRing}
          onClick={onLive}
          size="sm"
          variant="outline"
        >
          Return to live
        </Button>
      </div>
    </section>
  );
}

type BarKind = "frozen" | "staged" | "progress" | "elsewhere" | "none";

function barKind(
  frozen: boolean,
  waiting: boolean,
  clusters: StagedCluster[],
  recent: RecentRequest[],
  elsewhere: Elsewhere
): BarKind {
  if (frozen) {
    return waiting ? "frozen" : "none";
  }
  if (clusters.length > 0) {
    return "staged";
  }
  if (recent.length > 0) {
    return "progress";
  }
  return hasElsewhere(elsewhere) ? "elsewhere" : "none";
}

// One short summary for the bar's single live region. It exists before any
// card mounts, so staging the first change and starting an apply are
// announced; the cards themselves are not live regions.
function announcement(
  kind: BarKind,
  clusters: StagedCluster[],
  recent: RecentRequest[],
  elsewhere: Elsewhere,
  emptied: boolean
) {
  if (kind === "staged") {
    const count = plural(stagedCount(clusters), "change");
    return clusters.some((cluster) => cluster.applying)
      ? `Applying ${count}…`
      : `${count} staged, not applied`;
  }
  if (kind === "progress") {
    return progressHeading(recent).text;
  }
  if (kind === "elsewhere") {
    return elsewhereText(elsewhere);
  }
  return kind === "none" && emptied
    ? "No staged changes left. Nothing waiting to apply."
    : "";
}

// Moves focus to `target` on the next frame, unless it already landed
// somewhere real.
function recoverFocus(target: () => HTMLElement | null, done?: () => void) {
  const frame = requestAnimationFrame(() => {
    done?.();
    const active = document.activeElement;
    if (!active || active === document.body) {
      target()?.focus();
    }
  });
  return () => cancelAnimationFrame(frame);
}

// When the card holding focus unmounts (its last change discarded or
// applied, a progress card dismissed, frozen view resumed), its buttons, menu
// and dialogs go with it and focus would drop to the page body; so does the
// line about other clusters, with its button, when it goes. Moves focus to
// `target` then. Also reports whether the bar just emptied after staged
// changes.
function useFocusRecovery(
  kind: BarKind,
  others: boolean,
  target: () => HTMLElement | null
) {
  const last = useRef({ kind, others });
  const latestTarget = useRef(target);
  latestTarget.current = target;
  const [emptied, setEmptied] = useState(false);
  useEffect(() => {
    const was = last.current;
    last.current = { kind, others };
    if (was.kind === kind) {
      return was.others && !others
        ? recoverFocus(() => latestTarget.current())
        : undefined;
    }
    setEmptied(kind === "none" && was.kind === "staged");
    if (was.kind === "none") {
      return;
    }
    return recoverFocus(() => latestTarget.current());
  }, [kind, others]);
  return emptied;
}

// Show all clusters removes the button it was pressed on, and on the canvas
// the bar remounts with the new scope (the canvas is keyed by it), so the
// request to focus the card heading outlives the bar that made it.
let headingWanted = false;

// Clears the cluster filter as choosing All clusters in the top bar does,
// then focuses the card heading.
function useShowAll(target: () => HTMLElement | null) {
  const navigate = useNavigate({ from: "/" });
  const { cluster } = useSearch({ from: "/" });
  const latestTarget = useRef(target);
  latestTarget.current = target;
  useEffect(() => {
    if (cluster !== undefined || !headingWanted) {
      return;
    }
    return recoverFocus(
      () => latestTarget.current(),
      () => {
        headingWanted = false;
      }
    );
  }, [cluster]);
  return () => {
    headingWanted = true;
    navigate({
      search: (old) => ({ ...old, ...scopeReset, cluster: undefined }),
    });
  };
}

function focusable(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && !element.matches(":disabled");
}

// Apply, Details and the pause confirmation live with the bar, not the card,
// so they close normally (and hand focus back) when the card goes away.
function useStagedControls(
  clusters: StagedCluster[],
  focusTarget: () => HTMLElement | null
) {
  const apply = useApplyStaged();
  const [details, setDetails] = useState(false);
  // Clusters waiting for the pause confirmation, re-read on confirm so the
  // latest drafts are sent.
  const [confirming, setConfirming] = useState<string[]>();
  // The card control that opened a dialog, to return focus to it.
  const opener = useRef<HTMLElement | null>(null);
  const empty = clusters.length === 0;
  useEffect(() => {
    if (empty) {
      setDetails(false);
      setConfirming(undefined);
    }
  }, [empty]);
  const remember = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest("[role=dialog]")) {
      opener.current = active;
    }
  };
  const confirmTargets = confirming
    ? clusters.filter((cluster) => confirming.includes(cluster.view.cluster.id))
    : [];
  const blocked = (targets: StagedCluster[]) =>
    targets.some((cluster) => cluster.problems.length > 0);
  return {
    applying: apply.isPending || clusters.some((cluster) => cluster.applying),
    confirmTargets,
    details: details && !empty,
    finalFocus: (): HTMLElement | boolean => {
      const element = opener.current;
      return focusable(element) ? element : (focusTarget() ?? true);
    },
    openDetails: () => {
      remember();
      setDetails(true);
    },
    setDetails,
    cancelConfirm: () => setConfirming(undefined),
    confirm: () => {
      setConfirming(undefined);
      // The display clock moved on while the dialog was open: a diagnostic
      // about to end blocks the apply, as it does from the card.
      if (blocked(confirmTargets)) {
        setDetails(true);
        return;
      }
      apply.mutate(confirmTargets);
    },
    start: () => {
      remember();
      if (blocked(clusters)) {
        setDetails(true);
        return;
      }
      if (pausingClusters(clusters).length > 0) {
        // One modal at a time: the confirmation replaces Details.
        setDetails(false);
        setConfirming(clusters.map((cluster) => cluster.view.cluster.id));
        return;
      }
      apply.mutate(clusters);
    },
  };
}

function useBarState() {
  const search = useSearch({ from: "/" });
  const { frozen, now } = useDisplay();
  const staged = useStagedState();
  const live = !frozen;
  const cached = useLiveSnapshot(search.workspace, live);
  const views = live ? (cached ?? noViews) : noViews;
  // Polling, pruning and settling keep every cluster in the workspace scope
  // current; only what the card shows and acts on follows the cluster filter.
  useAcknowledgmentPolling(views, staged.requests, search.workspace, live);
  useEffect(() => {
    if (live && now) {
      pruneStaged(views, now);
      settleRequests(views, now);
    }
  }, [live, now, views]);
  // The filtered cluster, plus on Settings one a link opened that the filter
  // hides (Settings edits it there too).
  const { cluster, settingsCluster, view } = search;
  const shown = useMemo(
    () => shownClusterIds(views, { cluster, settingsCluster, view }),
    [views, cluster, settingsCluster, view]
  );
  const scope = useMemo(
    () => (now ? stagedScope(staged, views, shown, now) : noScope),
    [staged, views, shown, now]
  );
  const waiting =
    frozen && stagedWaiting(staged, search.workspace, cached, now);
  return {
    ...scope,
    kind: barKind(
      frozen,
      waiting,
      scope.clusters,
      scope.recent,
      scope.elsewhere
    ),
  };
}

// The floating "Apply N changes" card. Shows staged changes for the clusters
// in the current workspace scope (only the filtered cluster when the top bar
// picks one, plus on Settings a cluster a link opened), then acknowledgment
// progress once applied. `focusFallback` names a visible element to focus
// when the card goes away with focus inside it; otherwise a visually hidden
// note in the bar's place takes it.
export function StagedChangesBar({
  className,
  focusFallback,
}: {
  className?: string;
  focusFallback?: () => HTMLElement | null | undefined;
}) {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const { clusters, discard, elsewhere, kind, recent } = useBarState();
  const heading = useRef<HTMLParagraphElement>(null);
  const anchor = useRef<HTMLParagraphElement>(null);
  const focusTarget = () =>
    heading.current ?? focusFallback?.() ?? anchor.current;
  const controls = useStagedControls(clusters, focusTarget);
  const emptied = useFocusRecovery(kind, hasElsewhere(elsewhere), focusTarget);
  const showAll = useShowAll(focusTarget);
  const onSettings =
    search.view === "settings"
      ? undefined
      : (cluster?: string) =>
          navigate({
            search: (old) => ({
              ...old,
              view: "settings",
              // Names the section to open; the cluster filter stays.
              settingsCluster: cluster,
              ...inspectorReset,
              diagnosticNode: undefined,
            }),
          });
  return (
    <>
      <p aria-atomic="true" className="sr-only" role="status">
        {announcement(kind, clusters, recent, elsewhere, emptied)}
      </p>
      {kind === "none" && (
        <p
          className={cn(
            "sr-only focus-visible:not-sr-only focus-visible:block focus-visible:rounded-md focus-visible:border focus-visible:bg-popover focus-visible:px-3 focus-visible:py-2 focus-visible:text-muted-foreground focus-visible:text-xs",
            headingFocus
          )}
          ref={anchor}
          tabIndex={-1}
        >
          No staged collection changes.
        </p>
      )}
      {kind === "frozen" && (
        <FrozenCard
          className={className}
          heading={heading}
          onLive={() =>
            navigate({ search: (old) => ({ ...old, at: undefined }) })
          }
        />
      )}
      {kind === "staged" && (
        <StagedCard
          applying={controls.applying}
          className={className}
          clusters={clusters}
          elsewhere={elsewhere}
          heading={heading}
          onApply={controls.start}
          onDetails={controls.openDetails}
          onDiscardAll={() => discardStaged(discard)}
          onShowAll={showAll}
        />
      )}
      {kind === "progress" && (
        <ProgressCard
          className={className}
          elsewhere={elsewhere}
          heading={heading}
          onSettings={onSettings}
          onShowAll={showAll}
          recent={recent}
        />
      )}
      {kind === "elsewhere" && (
        <ElsewhereCard
          className={className}
          elsewhere={elsewhere}
          heading={heading}
          onShowAll={showAll}
        />
      )}
      <StagedDetails
        applying={controls.applying}
        clusters={clusters}
        finalFocus={controls.finalFocus}
        onApply={controls.start}
        onOpenChange={controls.setDetails}
        open={controls.details}
      />
      <PauseConfirm
        finalFocus={controls.finalFocus}
        onCancel={controls.cancelConfirm}
        onConfirm={controls.confirm}
        targets={controls.confirmTargets}
      />
    </>
  );
}
