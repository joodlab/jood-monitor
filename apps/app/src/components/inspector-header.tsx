import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  SheetClose,
  SheetDescription,
  SheetTitle,
} from "@jood-monitor/ui/sheet";
import { ArrowLeft, ChevronRight, XIcon } from "lucide-react";
import { useState } from "react";
import { freshness } from "../lib/metrics";
import { CopyButton } from "./inspector-copy";
import { type Crumb, inspectionKey, nextTrail } from "./inspector-model";
import { StatusBadge } from "./resource-status";

// The trail of recently inspected resources for this open sheet. It resets
// when the sheet closes so a new inspection starts a new trail.
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

export function InspectorHeader({
  view,
  entity,
  trail,
  referenceTime,
  onInspect,
}: {
  view: ClusterView;
  entity: Entity;
  trail: readonly Crumb[];
  referenceTime: number;
  onInspect: (view: ClusterView, entity: Entity) => void;
}) {
  const back = trail.at(-2);
  const stale = freshness(view.inventory.sourceTime, referenceTime) !== "fresh";
  return (
    <header className="sticky top-0 z-10 space-y-2 border-b bg-popover px-4 pt-2 pb-3">
      <div className="-mx-2 flex items-center gap-1">
        {back ? (
          <Button
            aria-label={`Back to ${back.entity.kind} ${back.entity.name}`}
            className="h-9 sm:h-8"
            onClick={() => onInspect(back.view, back.entity)}
            size="sm"
            title={`Back to ${back.entity.name}`}
            variant="ghost"
          >
            <ArrowLeft aria-hidden />
            Back
          </Button>
        ) : null}
        <Trail onInspect={onInspect} trail={trail} />
        <CopyButton
          label="Copy link to this resource"
          link
          text="Copy link"
          value={() => window.location.href}
        />
        <SheetClose
          render={
            <Button
              aria-label="Close inspector"
              className="size-9 sm:size-8"
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <XIcon aria-hidden />
        </SheetClose>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{entity.kind}</Badge>
        <StatusBadge entity={entity} stale={stale} />
        <SheetDescription className="min-w-0 truncate text-xs">
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
      </div>
      <div className="flex items-start gap-1">
        <SheetTitle className="min-w-0 flex-1 break-all pt-1 font-mono text-base leading-snug">
          {entity.name}
        </SheetTitle>
        <CopyButton label={`Copy name ${entity.name}`} value={entity.name} />
        {entity.namespace && (
          <CopyButton
            label={`Copy ${entity.namespace}/${entity.name}`}
            text="ns/name"
            value={`${entity.namespace}/${entity.name}`}
          />
        )}
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
  if (trail.length < 2) {
    return <div className="flex-1" />;
  }
  // The latest three; Back covers the previous one on narrow screens.
  const shown = trail.slice(-3);
  return (
    <>
      <div className="flex-1 sm:hidden" />
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
                    className="max-w-[9rem] truncate px-1 font-mono"
                    title={`${crumb.entity.kind} ${crumb.entity.name}`}
                  >
                    {crumb.entity.name}
                  </span>
                ) : (
                  <button
                    aria-label={`${crumb.entity.kind} ${crumb.entity.name}`}
                    className="h-8 min-w-0 max-w-[8rem] truncate rounded px-1 font-mono text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
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
    </>
  );
}
