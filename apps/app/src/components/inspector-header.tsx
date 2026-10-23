import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  SheetClose,
  SheetDescription,
  SheetTitle,
} from "@jood-monitor/ui/sheet";
import { ArrowLeft, ChevronRight, XIcon } from "lucide-react";
import { type Ref, useState } from "react";
import { liveNodeProblem } from "../lib/attention";
import { summarize } from "../lib/infrastructure";
import { inventoryFreshness } from "../lib/metrics";
import { serviceStatusDetail } from "../lib/resource-table";
import type { HubClock } from "../lib/time";
import type { PanelTab, SearchState } from "../schemas/monitor";
import { CopyButton, CopyLinkMenu } from "./inspector-copy";
import { type Crumb, inspectionKey, nextTrail } from "./inspector-model";
import { KindTile, StatusBadge, type StatusDetail } from "./resource-status";

// What the link menu needs: the page's search, the tab on screen and the
// hub clock that bounds a pinned moment.
export interface LinkContext {
  hubClock?: HubClock;
  panel: PanelTab;
  search: SearchState;
}

// The trail of recently inspected resources for this open panel. It resets
// when the panel closes so a new inspection starts a new trail.
export function useInspectionTrail(
  inspected: { view: ClusterView; entity: Entity } | null
) {
  const key = inspected ? inspectionKey(inspected.view, inspected.entity) : "";
  const [state, setState] = useState<{ key: string; trail: Crumb[] }>({
    key: "",
    trail: [],
  });
  if (state.key !== key) {
    const trail = inspected
      ? nextTrail(state.trail, { key, ...inspected })
      : [];
    setState({ key, trail });
    return trail;
  }
  return state.trail;
}

const iconButton =
  "size-9 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

// The header badge's verdict, as on the Resources row that opens it: nodes
// follow the attention rule (memory near full included), and a Service
// follows the shared Service rule, naming its reason (routed with no
// endpoint pods, or endpoint pods not all ready). Every other kind keeps the
// badge's own rule.
export function headerStatus(
  view: ClusterView,
  entity: Entity,
  referenceTime: number
): { detail?: StatusDetail; problem?: boolean } {
  if (entity.kind === "Node") {
    return { problem: liveNodeProblem(view, entity, referenceTime) };
  }
  if (entity.kind === "Service") {
    const detail = serviceStatusDetail(
      view,
      entity,
      summarize(view, entity, referenceTime),
      referenceTime
    );
    return detail ? { detail, problem: true } : {};
  }
  return {};
}

// Railway's service header: a large kind tile and name, the status pill and
// where the resource lives, with copy actions and close on the right. Back
// follows browser history when the previous entry is that resource (see
// panel-history).
export function InspectorHeader({
  view,
  entity,
  trail,
  referenceTime,
  onInspect,
  onBack,
  titleRef,
  link,
}: {
  view: ClusterView;
  entity: Entity;
  trail: readonly Crumb[];
  referenceTime: number;
  onInspect: (view: ClusterView, entity: Entity) => void;
  onBack: (crumb: Crumb) => void;
  // The title takes focus when a switch from inside the panel would lose it.
  titleRef?: Ref<HTMLHeadingElement>;
  link: LinkContext;
}) {
  const back = trail.at(-2);
  const stale =
    inventoryFreshness(view.inventory.sourceTime, referenceTime) !== "fresh";
  const status = headerStatus(view, entity, referenceTime);
  return (
    <header className="space-y-3 px-4 pt-3 sm:px-6 sm:pt-4">
      {back && (
        <div className="-mx-2 flex min-h-9 items-center gap-1">
          <Button
            aria-label={`Back to ${back.entity.kind} ${back.entity.name}`}
            className="h-9 shrink-0 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
            onClick={() => onBack(back)}
            size="sm"
            title={`Back to ${back.entity.name}`}
            variant="ghost"
          >
            <ArrowLeft aria-hidden />
            Back
          </Button>
          <Trail onInspect={onInspect} trail={trail} />
        </div>
      )}
      <div className="flex items-start gap-3 sm:gap-4">
        {/* The same tile as the resource's canvas card, at panel scale. */}
        <KindTile
          className="mt-0.5 size-12 rounded-xl text-foreground/80 sm:size-14 [&>svg]:size-6 sm:[&>svg]:size-7"
          kind={entity.kind}
        />
        <div className="min-w-0 flex-1 space-y-2 pt-0.5">
          <SheetTitle
            className="font-semibold text-xl leading-tight tracking-tight outline-none [overflow-wrap:anywhere] sm:text-2xl"
            ref={titleRef}
            tabIndex={-1}
          >
            {entity.name}
          </SheetTitle>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge
              detail={status.detail}
              entity={entity}
              problem={status.problem}
              stale={stale}
            />
            <SheetDescription className="min-w-0 text-xs">
              {entity.kind} ·{" "}
              {entity.namespace ? (
                <>
                  namespace{" "}
                  <span className="font-mono text-foreground/80">
                    {entity.namespace}
                  </span>
                </>
              ) : (
                "cluster scope"
              )}{" "}
              · {view.cluster.name}
            </SheetDescription>
            {entity.namespace && (
              // The visible words lead the accessible name so voice control
              // ("click copy ns/name") reaches it; the full value follows.
              <CopyButton
                className="-my-1 focus-visible:ring-2 focus-visible:ring-ring"
                label={`Copy ns/name ${entity.namespace}/${entity.name}`}
                text="Copy ns/name"
                value={`${entity.namespace}/${entity.name}`}
              />
            )}
          </div>
        </div>
        <div className="-mt-1 -mr-2 flex shrink-0 items-center">
          <CopyButton
            className={iconButton}
            label={`Copy name ${entity.name}`}
            value={entity.name}
          />
          <CopyLinkMenu
            className={iconButton}
            hubClock={link.hubClock}
            panel={link.panel}
            search={link.search}
            sourceTime={view.inventory.sourceTime}
          />
          <SheetClose
            render={
              <Button
                aria-label="Close inspector"
                className={iconButton}
                size="icon"
                title="Close (Esc)"
                variant="ghost"
              />
            }
          >
            <XIcon aria-hidden className="size-5" />
          </SheetClose>
        </div>
      </div>
    </header>
  );
}

function Trail({
  trail,
  onInspect,
}: {
  trail: readonly Crumb[];
  onInspect: (view: ClusterView, entity: Entity) => void;
}) {
  // The latest three; Back covers the previous one on narrow screens.
  const shown = trail.slice(-3);
  return (
    <nav
      aria-label="Recently inspected"
      className="hidden min-w-0 flex-1 sm:block"
    >
      <ol className="flex min-w-0 items-center gap-0.5 overflow-hidden text-xs">
        {trail.length > shown.length && (
          <li aria-hidden className="px-1 text-muted-foreground">
            …
          </li>
        )}
        {shown.map((crumb, index) => {
          const current = index === shown.length - 1;
          return (
            <li
              className="flex min-w-0 shrink items-center gap-0.5 last:shrink-0"
              key={crumb.key}
            >
              {(index > 0 || trail.length > shown.length) && (
                <ChevronRight
                  aria-hidden
                  className="size-3 shrink-0 text-muted-foreground"
                />
              )}
              {current ? (
                <span
                  aria-current="page"
                  className="max-w-[12rem] truncate px-1 font-mono"
                  title={`${crumb.entity.kind} ${crumb.entity.name}`}
                >
                  {crumb.entity.name}
                </span>
              ) : (
                <button
                  aria-label={`${crumb.entity.kind} ${crumb.entity.name}`}
                  className="h-8 min-w-0 max-w-[10rem] truncate rounded px-1 font-mono text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onInspect(crumb.view, crumb.entity)}
                  title={`${crumb.entity.kind} ${crumb.entity.name}`}
                  type="button"
                >
                  {crumb.entity.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
