import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import type { UseQueryResult } from "@tanstack/react-query";
import { Activity, Network, Plus } from "lucide-react";
import {
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useRef,
  useState,
} from "react";
import { useDisplay } from "../hooks/display";
import type { Attention } from "../lib/attention";
import { isSystemNamespace } from "../lib/infrastructure";
import type { TopologyLayout } from "../lib/service-graph";
import type { SearchState } from "../schemas/monitor";
import type { AttentionActions } from "./attention-list";
import { ActivityPanel, AttentionCount } from "./canvas-activity";
import { ConnectClusterCard } from "./canvas-empty";
import { panelQuery, useMediaQuery } from "./canvas-hooks";
import { CanvasScope } from "./canvas-scope";
import { EmptyState } from "./page";
import { StagedChangesBar } from "./staged-changes";

// React Flow is only needed on this view, so it loads with it.
const Topology = lazy(() =>
  import("./topology").then((module) => ({ default: module.Topology }))
);

export interface ArchitectureProps {
  actions: AttentionActions;
  allViews: ClusterView[];
  attention: Attention[];
  events: UseQueryResult<Lifecycle[], Error>;
  inspect: (view: ClusterView, entity: Entity) => void;
  namespaces: string[];
  onConnect: () => void;
  onNavigate: (view: string, extra?: Partial<SearchState>) => void;
  referenceTime: number;
  search: SearchState;
  update: (next: Partial<SearchState>, replace?: boolean) => void;
  views: ClusterView[];
}

// Width the open Activity panel covers, kept clear when fitting the canvas.
const panelWidth = 352;
const dotted =
  "bg-[radial-gradient(color-mix(in_oklab,var(--muted-foreground)_45%,transparent)_1.2px,transparent_1.2px)] bg-size-[22px_22px]";

function ConnectButton({
  onConnect,
  frozen,
}: {
  onConnect: () => void;
  frozen: boolean;
}) {
  return (
    <Button
      aria-label="Connect cluster"
      className="h-9 bg-card/95 shadow-sm backdrop-blur focus-visible:ring-2 focus-visible:ring-ring dark:bg-card/95"
      disabled={frozen}
      onClick={onConnect}
      title={frozen ? "Return to live to connect a cluster" : undefined}
      variant="outline"
    >
      <Plus aria-hidden="true" />
      <span className="hidden sm:inline">Connect cluster</span>
    </Button>
  );
}

function ActivityToggle({
  open,
  attention,
  onToggle,
  ref,
}: {
  open: boolean;
  attention: Attention[];
  onToggle: () => void;
  ref: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Button
      aria-expanded={open}
      className="h-9 bg-card/95 shadow-sm backdrop-blur focus-visible:ring-2 focus-visible:ring-ring dark:bg-card/95"
      onClick={onToggle}
      ref={ref}
      variant="outline"
    >
      <Activity aria-hidden="true" className="text-primary" />
      Activity
      <AttentionCount attention={attention} />
    </Button>
  );
}

// No cluster to draw: Railway's empty project, one dashed card in the middle
// of the canvas; or, for a cluster link that no longer matches, a way back.
function EmptyCanvas({
  props,
  frozen,
}: {
  props: ArchitectureProps;
  frozen: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-[480px] flex-1 items-center justify-center p-6",
        dotted
      )}
    >
      <h1 className="sr-only">Architecture</h1>
      {props.allViews.length === 0 ? (
        <ConnectClusterCard disabled={frozen} onConnect={props.onConnect} />
      ) : (
        <EmptyState
          className="max-w-md bg-card/95"
          description="The selected cluster is not in this workspace or has been removed."
          icon={Network}
          title="Cluster not found"
        >
          <Button
            className="focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() =>
              props.update({ cluster: undefined, namespace: "all" })
            }
            size="sm"
            variant="outline"
          >
            Show all clusters
          </Button>
        </EmptyState>
      )}
    </div>
  );
}

function useCanvasCallbacks(update: ArchitectureProps["update"]) {
  // Drilling into a namespace is navigation, so Back returns to the map;
  // filter and layout changes replace the entry.
  const onNamespace = useCallback(
    (namespace: string) => update({ namespace }),
    [update]
  );
  const onLayout = useCallback(
    (layout: TopologyLayout) => update({ layout }, true),
    [update]
  );
  const onShowSystem = useCallback(
    () => update({ system: true }, true),
    [update]
  );
  const onProblems = useCallback(
    (problems: boolean) => update({ problems }, true),
    [update]
  );
  const onSystem = useCallback(
    (system: boolean) => update({ system }, true),
    [update]
  );
  const onSearch = useCallback((q: string) => update({ q }, true), [update]);
  return {
    onNamespace,
    onLayout,
    onShowSystem,
    onProblems,
    onSystem,
    onSearch,
  };
}

// Railway-style architecture canvas: the landing view. Configured and
// discovered structure fills the space under the project bar, with floating
// controls, scope, actions and the Activity panel on top.
export function Architecture(props: ArchitectureProps) {
  const { search, views } = props;
  const { frozen } = useDisplay();
  const narrow = useMediaQuery(panelQuery);
  const [panelChoice, setPanelChoice] = useState<boolean>();
  const callbacks = useCanvasCallbacks(props.update);
  const toggle = useRef<HTMLButtonElement>(null);
  if (!views.length) {
    return <EmptyCanvas frozen={frozen} props={props} />;
  }
  const panelOpen = panelChoice ?? !narrow;
  const systemLocked = isSystemNamespace(search.namespace);
  const navigate = (view: string) => props.onNavigate(view);
  // Where the panel covers the canvas, closing it hands focus back to the
  // button that opened it.
  const setPanel = (open: boolean) => {
    setPanelChoice(open);
    if (narrow && !open) {
      toggle.current?.focus();
    }
  };
  const panel =
    narrow && !panelOpen ? null : (
      <ActivityPanel
        actions={props.actions}
        attention={props.attention}
        className="w-[min(22rem,calc(100vw-1.5rem))]"
        dismissible={narrow}
        events={props.events}
        onNavigate={navigate}
        onOpenChange={setPanel}
        open={panelOpen}
        range={search.range}
        referenceTime={props.referenceTime}
        views={views}
      />
    );
  return (
    <div className="relative min-h-[480px] flex-1">
      <h1 className="sr-only">Architecture</h1>
      <Suspense
        fallback={
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center text-muted-foreground text-sm",
              dotted
            )}
            role="status"
          >
            Loading canvas…
          </div>
        }
      >
        <Topology
          className="absolute inset-0"
          insetRight={panelOpen && !narrow ? panelWidth : 16}
          key={`${search.workspace}:${search.cluster ?? "all"}:${search.namespace}:${search.at ? "frozen" : "live"}`}
          layout={search.layout}
          namespace={search.namespace}
          onInspect={props.inspect}
          onLayout={callbacks.onLayout}
          onNamespace={callbacks.onNamespace}
          onProblems={callbacks.onProblems}
          onShowSystem={callbacks.onShowSystem}
          onSystem={callbacks.onSystem}
          overlays={{
            scope: (
              <CanvasScope
                namespace={search.namespace}
                namespaces={props.namespaces}
                onNamespace={callbacks.onNamespace}
                onSearch={callbacks.onSearch}
                q={search.q}
              />
            ),
            below: <StagedChangesBar className="max-w-80 shadow-lg" />,
            actions: (
              <>
                {narrow && (
                  <ActivityToggle
                    attention={props.attention}
                    onToggle={() => setPanel(!panelOpen)}
                    open={panelOpen}
                    ref={toggle}
                  />
                )}
                <ConnectButton frozen={frozen} onConnect={props.onConnect} />
              </>
            ),
            panel,
          }}
          problems={search.problems}
          referenceTime={props.referenceTime}
          search={search.q}
          showSystem={search.system || systemLocked}
          systemLocked={systemLocked}
          views={views}
        />
      </Suspense>
    </div>
  );
}
