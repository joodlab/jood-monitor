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
import { useEffect, useId, useMemo, useState } from "react";
import { updateProfileFn } from "../functions/clusters";
import { fetchSnapshot } from "../hooks/api/clusters";
import { useDisplay } from "../hooks/display";
import { requestError } from "../lib/install-errors";
import {
  applyFailed,
  applySucceeded,
  discardStaged,
  markApplying,
  pausingClusters,
  pruneStaged,
  type RecentRequest,
  recentRequests,
  revertField,
  type StagedCluster,
  type StagedRow,
  stageDraft,
  stagedClusters,
  stagedCount,
  useStagedState,
} from "../lib/staged-changes";
import { profileSchema } from "../schemas/clusters";
import type { AckRequest, DraftField } from "./collection-model";
import {
  ackPollDelay,
  latestPendingRequest,
  profileRequest,
  progressSummary,
  validationText,
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

// The live snapshot the dashboard already keeps fresh. This reader adds no
// schedule of its own; it fetches only when nothing is cached yet.
function useLiveViews(scope: string, frozen: boolean) {
  const snapshot = useQuery({
    queryKey: ["snapshot", scope, "live"],
    queryFn: () => fetchSnapshot(scope),
    enabled: !frozen,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  return useMemo<ClusterView[]>(
    () => (frozen ? [] : (snapshot.data?.clusters ?? [])),
    [frozen, snapshot.data]
  );
}

// While any request awaits acknowledgment, the live snapshot is refreshed on
// a capped backoff (10 s, 20 s, then every 30 s) from the latest request
// until the patience window ends. Hidden tabs skip refreshes; the query
// refetches on focus. A slow scope-wide fetch is not cancelled by the next
// tick.
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

async function applyCluster(target: StagedCluster) {
  const id = target.view.cluster.id;
  const parsed = profileSchema.safeParse(
    profileRequest(target.draft, target.view.profile, Date.now())
  );
  if (!parsed.success) {
    applyFailed(id, validationText(parsed.error));
    return;
  }
  try {
    const result = await updateProfileFn({
      headers: { "X-Jood-CSRF": "1" },
      data: { clusterId: id, profile: parsed.data },
    });
    applySucceeded(id, { revision: result.revision, at: Date.now() });
  } catch (error) {
    applyFailed(id, requestError(error).message);
  }
}

// Sends each staged cluster's profile. A failure keeps that cluster's
// changes staged with the reason; the others still apply.
function useApplyStaged() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (targets: StagedCluster[]) => {
      markApplying(targets.map((target) => target.view.cluster.id));
      await Promise.all(targets.map(applyCluster));
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["snapshot"] }),
  });
}

function PauseConfirm({
  targets,
  onCancel,
  onConfirm,
}: {
  targets: StagedCluster[];
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
      <DialogContent>
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
          <Button onClick={onCancel} variant="outline">
            Keep collecting
          </Button>
          <Button onClick={onConfirm} variant="warning">
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
  onOpenChange,
  onApply,
}: {
  open: boolean;
  clusters: StagedCluster[];
  applying: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: () => void;
}) {
  const count = stagedCount(clusters);
  const blocked = clusters.filter((cluster) => cluster.problems.length > 0);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-0 p-0 sm:max-w-3xl">
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
            <Button disabled={applying || blocked.length > 0} onClick={onApply}>
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

function StagedCard({
  className,
  clusters,
  onDiscardAll,
}: {
  className?: string;
  clusters: StagedCluster[];
  onDiscardAll: () => void;
}) {
  const apply = useApplyStaged();
  const [details, setDetails] = useState(false);
  // Clusters waiting for the pause confirmation, re-read on confirm so the
  // latest drafts are sent.
  const [confirming, setConfirming] = useState<string[]>();
  const count = stagedCount(clusters);
  const applying =
    apply.isPending || clusters.some((cluster) => cluster.applying);
  const ids = clusters.map((cluster) => cluster.view.cluster.id);
  const confirmTargets = confirming
    ? clusters.filter((cluster) => confirming.includes(cluster.view.cluster.id))
    : [];
  function start() {
    if (clusters.some((cluster) => cluster.problems.length > 0)) {
      setDetails(true);
      return;
    }
    if (pausingClusters(clusters).length > 0) {
      // One modal at a time: the confirmation replaces Details.
      setDetails(false);
      setConfirming(ids);
      return;
    }
    apply.mutate(clusters);
  }
  return (
    <>
      <section
        aria-label="Staged changes"
        className={cn(cardBase, "border-staged/40", className)}
      >
        <p className="font-medium text-sm text-staged-text" role="status">
          {applying
            ? `Applying ${plural(count, "change")}…`
            : `Apply ${plural(count, "change")}`}
        </p>
        <StagedStatus clusters={clusters} />
        <div className="flex items-center gap-2 pt-2">
          <Button onClick={() => setDetails(true)} size="sm" variant="outline">
            Details
          </Button>
          <Button disabled={applying} onClick={start} size="sm">
            Apply
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="More staged change actions"
                  className="ml-auto"
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
                Discard all changes
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>
      <StagedDetails
        applying={applying}
        clusters={clusters}
        onApply={start}
        onOpenChange={setDetails}
        open={details}
      />
      <PauseConfirm
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => {
          setConfirming(undefined);
          apply.mutate(confirmTargets);
        }}
        targets={confirmTargets}
      />
    </>
  );
}

function ProgressCard({
  className,
  recent,
  onSettings,
}: {
  className?: string;
  recent: RecentRequest[];
  onSettings?: (clusterId?: string) => void;
}) {
  const done = recent.every((item) => item.progress?.phase === "complete");
  return (
    <section
      aria-label="Collection changes"
      className={cn(cardBase, className)}
    >
      <p className="flex items-center gap-1.5 font-medium text-sm">
        {done ? (
          <CircleCheck aria-hidden className="size-4 text-success-text" />
        ) : (
          <Clock aria-hidden className="size-4 text-info-text" />
        )}
        {done ? "Collection changes applied" : "Applying collection changes"}
      </p>
      <ul className="space-y-0.5 text-xs" role="status">
        {recent.map((item) => (
          <li key={item.view.cluster.id}>
            <span className="font-medium">{item.view.cluster.name}</span>
            <span className="text-muted-foreground">
              {" "}
              ·{" "}
              {item.progress
                ? progressSummary(item.progress)
                : "Sending to the hub…"}
            </span>
          </li>
        ))}
      </ul>
      {onSettings && (
        <div className="pt-2">
          <Button
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
        </div>
      )}
    </section>
  );
}

function FrozenCard({
  className,
  onLive,
}: {
  className?: string;
  onLive: () => void;
}) {
  return (
    <section
      aria-label="Staged changes"
      className={cn(cardBase, "border-staged/40", className)}
    >
      <p className="font-medium text-sm text-staged-text">
        Staged changes are waiting
      </p>
      <p className="text-muted-foreground text-xs">
        Reviewing and applying collection changes is only available live. They
        stay staged for this browser session.
      </p>
      <div className="pt-2">
        <Button onClick={onLive} size="sm" variant="outline">
          Return to live
        </Button>
      </div>
    </section>
  );
}

// The floating "Apply N changes" card. Shows staged changes for the clusters
// in the current workspace scope, then acknowledgment progress once applied.
export function StagedChangesBar({ className }: { className?: string }) {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const { frozen, now } = useDisplay();
  const staged = useStagedState();
  const live = !frozen;
  const views = useLiveViews(search.workspace, frozen);
  useAcknowledgmentPolling(views, staged.requests, search.workspace, live);
  useEffect(() => {
    if (live && now) {
      pruneStaged(views, now);
    }
  }, [live, now, views]);
  const clusters = useMemo(
    () => (now ? stagedClusters(staged, views, now) : []),
    [staged, views, now]
  );
  const recent = useMemo(
    () => (now ? recentRequests(staged, views, now) : []),
    [staged, views, now]
  );
  if (frozen) {
    return Object.keys(staged.entries).length > 0 ? (
      <FrozenCard
        className={className}
        onLive={() =>
          navigate({ search: (old) => ({ ...old, at: undefined }) })
        }
      />
    ) : null;
  }
  if (clusters.length > 0) {
    return (
      <StagedCard
        className={className}
        clusters={clusters}
        onDiscardAll={() => discardStaged(views.map((view) => view.cluster.id))}
      />
    );
  }
  if (recent.length > 0) {
    return (
      <ProgressCard
        className={className}
        onSettings={
          search.view === "settings"
            ? undefined
            : (cluster) =>
                navigate({
                  search: (old) => ({
                    ...old,
                    view: "settings",
                    cluster: cluster ?? old.cluster,
                    resource: undefined,
                    resourceCluster: undefined,
                    diagnosticNode: undefined,
                  }),
                })
        }
        recent={recent}
      />
    );
  }
  return null;
}
