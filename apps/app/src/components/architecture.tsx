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
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useDisplay } from "../hooks/display";
import type { Attention } from "../lib/attention";
import { isSystemNamespace } from "../lib/infrastructure";
import { rectsOverlap, type TopologyLayout } from "../lib/service-graph";
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
  controls,
  onToggle,
  ref,
}: {
  open: boolean;
  attention: Attention[];
  // The panel's id while it is shown.
  controls?: string;
  onToggle: () => void;
  ref: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Button
      aria-controls={controls}
      aria-expanded={open}
      className="h-9 bg-card/95 shadow-sm backdrop-blur focus-visible:ring-2 focus-visible:ring-ring dark:bg-card/95"
      onClick={onToggle}
      ref={ref}
      variant="outline"
    >
      <Activity aria-hidden="true" className="text-primary" />
      {/* Compact on phones, like Connect, so the scope row keeps its room;
          the name stays "Activity" for assistive technology. */}
      <span className="sr-only sm:not-sr-only">Activity</span>
      <AttentionCount attention={attention} />
    </Button>
  );
}

// Below 1024px the open Activity panel covers part of the canvas. Keyboard
// focus landing on anything under it (a card, a list row or a toolbar
// button) closes it, so the focused control is never hidden.
function coveredByPanel(target: EventTarget, panel: HTMLElement | null) {
  if (!(panel && target instanceof HTMLElement) || panel.contains(target)) {
    return false;
  }
  return rectsOverlap(
    target.getBoundingClientRect(),
    panel.getBoundingClientRect()
  );
}

interface CanvasFocusOptions {
  // Closes the panel without moving focus.
  closePanel: () => void;
  // The open panel covers part of the canvas (below 1024px).
  covering: boolean;
  namespace: string;
  onNamespace: (namespace: string) => void;
  panelId: string;
}

// Keeps keyboard focus where the operator can see it. A namespace change
// remounts the canvas, controls included, so focus returns to the namespace
// pill instead of falling to the page body. Focus landing under a covering
// panel closes it. Native focusin only sees the canvas's own DOM, so
// portalled menus and dialogs, which float above the panel, never close it.
function useCanvasFocus(options: CanvasFocusOptions) {
  const { namespace, onNamespace, covering, panelId, closePanel } = options;
  const root = useRef<HTMLDivElement>(null);
  const requested = useRef<string>(undefined);
  const change = useCallback(
    (next: string) => {
      requested.current = next === namespace ? undefined : next;
      onNamespace(next);
    },
    [namespace, onNamespace]
  );
  useEffect(() => {
    const arrived = requested.current === namespace;
    requested.current = undefined;
    if (!arrived) {
      return;
    }
    // Next frame, after a closing menu returns focus to its detached trigger.
    const frame = requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>('[data-canvas-focus="namespace"]')
        ?.focus()
    );
    return () => cancelAnimationFrame(frame);
  }, [namespace]);
  useEffect(() => {
    const node = root.current;
    if (!(covering && node)) {
      return;
    }
    const onFocusIn = (event: FocusEvent) => {
      if (
        event.target &&
        coveredByPanel(event.target, document.getElementById(panelId))
      ) {
        closePanel();
      }
    };
    node.addEventListener("focusin", onFocusIn);
    return () => node.removeEventListener("focusin", onFocusIn);
  }, [covering, panelId, closePanel]);
  return { root, change };
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
  const panelId = useId();
  const panelOpen = panelChoice ?? !narrow;
  const closePanel = useCallback(() => setPanelChoice(false), []);
  const canvasFocus = useCanvasFocus({
    closePanel,
    covering: narrow && panelOpen && views.length > 0,
    namespace: search.namespace,
    onNamespace: callbacks.onNamespace,
    panelId,
  });
  if (!views.length) {
    return <EmptyCanvas frozen={frozen} props={props} />;
  }
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
        id={panelId}
        onNavigate={navigate}
        onOpenChange={setPanel}
        open={panelOpen}
        range={search.range}
        referenceTime={props.referenceTime}
        views={views}
      />
    );
  return (
    <div className="relative min-h-[480px] flex-1" ref={canvasFocus.root}>
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
          onNamespace={canvasFocus.change}
          onProblems={callbacks.onProblems}
          onShowSystem={callbacks.onShowSystem}
          onSystem={callbacks.onSystem}
          overlays={{
            scope: (
              <CanvasScope
                namespace={search.namespace}
                namespaces={props.namespaces}
                onNamespace={canvasFocus.change}
                onSearch={callbacks.onSearch}
                q={search.q}
                views={views}
              />
            ),
            below: <StagedChangesBar className="max-w-80 shadow-lg" />,
            actions: (
              <>
                {narrow && (
                  <ActivityToggle
                    attention={props.attention}
                    controls={panelOpen ? panelId : undefined}
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
