import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import { cn } from "@jood-monitor/ui/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { CornerDownLeft, Search } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchWorkspaces } from "../hooks/api/clusters";
import { useDisplay } from "../hooks/display";
import {
  type ActionId,
  type PaletteDestination,
  type PaletteItem,
  type PaletteTarget,
  paletteActions,
  paletteHref,
  paletteResults,
  targetPatch,
} from "../lib/palette";
import { ObservationTime } from "./observation-time";

// Keyboard-first jump to any page, namespace, cluster, workspace or observed
// resource, and a few view commands (⌘K / Ctrl+K). Results come from the
// loaded snapshot and the workspace list; nothing new is fetched.

const title = "Find a page, resource or action";

function usePaletteResults(
  query: string,
  pages: PaletteTarget[],
  views: ClusterView[]
) {
  const search = useSearch({ from: "/" });
  const { frozen, theme } = useDisplay();
  // The dashboard's own workspace query; this only reads it.
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
  });
  const list = workspaces.data;
  return useMemo(
    () =>
      paletteResults(query, {
        search,
        views,
        pages,
        workspaces: list ?? [],
        actions: paletteActions({
          frozen,
          theme,
          view: search.view,
          problems: search.problems,
        }),
      }),
    [query, search, views, pages, list, frozen, theme]
  );
}

// Back to what had focus before the finder opened, or the page's main region
// when that is gone.
function returnFocus(element: Element | null) {
  if (
    element instanceof HTMLElement &&
    element.isConnected &&
    element !== document.body
  ) {
    element.focus({ preventScroll: true });
    return;
  }
  const main = document.querySelector("main");
  if (!main) {
    return;
  }
  if (!main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
    main.addEventListener("blur", () => main.removeAttribute("tabindex"), {
      once: true,
    });
  }
  main.focus({ preventScroll: true });
}

// "View a saved observation…" opens the time picker once the finder has
// finished closing, and focus then returns to where the finder was opened.
function useObservationDialog(paletteOpen: boolean) {
  const [open, setOpen] = useState(false);
  const requested = useRef(false);
  const shown = useRef(false);
  const opener = useRef<Element | null>(null);
  // Before the finder's input takes focus, which happens after this commit.
  useLayoutEffect(() => {
    if (paletteOpen) {
      opener.current = document.activeElement;
    }
  }, [paletteOpen]);
  useEffect(() => {
    if (open) {
      shown.current = true;
    } else if (shown.current) {
      shown.current = false;
      returnFocus(opener.current);
    }
  }, [open]);
  return {
    open,
    setOpen,
    request: () => {
      requested.current = true;
    },
    paletteClosed: () => {
      if (requested.current) {
        requested.current = false;
        setOpen(true);
      }
    },
  };
}

function findInspected(
  views: ClusterView[],
  target: { clusterId: string; uid: string }
) {
  const view = views.find((item) => item.cluster.id === target.clusterId);
  const entity = view?.inventory.entities.find(
    (item) => item.uid === target.uid
  );
  return view && entity ? { view, entity } : undefined;
}

function usePaletteRun({
  views,
  onOpenChange,
  onInspect,
  onCluster,
  onSaved,
}: {
  views: ClusterView[];
  onOpenChange: (open: boolean) => void;
  onInspect: (view: ClusterView, entity: Entity) => void;
  onCluster: (view: ClusterView) => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate({ from: "/" });
  const router = useRouter();
  const search = useSearch({ from: "/" });
  const { theme, setTheme } = useDisplay();
  // Freezing and returning to live are pushed, as the Freeze button does;
  // Problems only replaces, as its toggles do.
  const actions: Record<ActionId, () => void> = {
    freeze: () =>
      navigate({ search: (old) => ({ ...old, at: new Date().toISOString() }) }),
    live: () => navigate({ search: (old) => ({ ...old, at: undefined }) }),
    problems: () =>
      navigate({
        search: (old) => ({ ...old, problems: !old.problems }),
        replace: true,
      }),
    saved: onSaved,
    theme: () => setTheme(theme === "dark" ? "light" : "dark"),
  };
  function go(target: PaletteDestination) {
    if ("patch" in target) {
      const { patch } = target;
      navigate({ search: (old) => ({ ...old, ...patch }) });
    } else if ("inspect" in target) {
      const found = findInspected(views, target.inspect);
      if (found) {
        onInspect(found.view, found.entity);
      }
    } else if ("page" in target) {
      target.page.run();
    } else if ("cluster" in target) {
      const { clusterId } = target.cluster;
      const view = views.find((item) => item.cluster.id === clusterId);
      if (view) {
        onCluster(view);
      }
    } else {
      actions[target.action]();
    }
  }
  return {
    run(item?: PaletteItem) {
      if (!item || item.disabled) {
        return;
      }
      onOpenChange(false);
      go(item.target);
    },
    // Navigational results only: actions change this tab, so they cannot
    // open another.
    openInTab(item?: PaletteItem) {
      const patch = item && !item.disabled && targetPatch(item.target);
      if (!patch) {
        return;
      }
      const { href } = router.buildLocation({
        to: "/",
        search: paletteHref(search, patch),
      });
      window.open(new URL(href, window.location.origin), "_blank", "noopener");
      onOpenChange(false);
    },
  };
}

function groupsOf(results: PaletteItem[]) {
  const groups = new Map<string, { result: PaletteItem; index: number }[]>();
  for (const [index, result] of results.entries()) {
    const list = groups.get(result.group);
    if (list) {
      list.push({ result, index });
    } else {
      groups.set(result.group, [{ result, index }]);
    }
  }
  return [...groups.entries()];
}

const monoGroups = new Set(["Namespaces", "Resources"]);

function Option({
  id,
  result,
  selected,
  onHover,
  onRun,
  onTab,
}: {
  id: string;
  result: PaletteItem;
  selected: boolean;
  onHover: () => void;
  onRun: () => void;
  onTab: () => void;
}) {
  function click(event: MouseEvent) {
    if (event.metaKey || event.ctrlKey) {
      onTab();
    } else {
      onRun();
    }
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns keyboard selection.
    <div
      aria-disabled={result.disabled || undefined}
      aria-selected={selected}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm",
        selected && "bg-muted",
        result.disabled && "cursor-default text-muted-foreground"
      )}
      id={id}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onTab();
        }
      }}
      onClick={click}
      // Focus stays in the input, and a middle press does not autoscroll.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      role="option"
      tabIndex={-1}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate",
            monoGroups.has(result.group) && "font-mono text-[13px]"
          )}
        >
          {result.label}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {result.disabled && result.reason
            ? `${result.detail} · ${result.reason}`
            : result.detail}
        </span>
      </span>
      {selected && !result.disabled && (
        <CornerDownLeft
          aria-hidden
          className="size-3.5 text-muted-foreground"
        />
      )}
    </div>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  pages,
  views,
  onInspect,
  onCluster,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: PaletteTarget[];
  views: ClusterView[];
  onInspect: (view: ClusterView, entity: Entity) => void;
  onCluster: (view: ClusterView) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  // The term is cleared once the finder has finished closing, so a closed
  // finder does not rescan the inventory on every address or snapshot change,
  // and reopening never shows the old results. Opening clears it too, in case
  // the finder reopened before it finished closing.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  const results = usePaletteResults(query, pages, views);
  const observation = useObservationDialog(open);
  const display = useDisplay();
  const navigate = useNavigate({ from: "/" });
  const { run, openInTab } = usePaletteRun({
    views,
    onOpenChange,
    onInspect,
    onCluster,
    onSaved: observation.request,
  });
  const selected = Math.min(active, Math.max(0, results.length - 1));
  // Keyboard moves keep the active option in view. Mouse hover never scrolls,
  // so a half-visible row under the pointer does not jump. Wrapping to the
  // first option scrolls to the top so its group heading stays visible.
  const list = useRef<HTMLDivElement>(null);
  function move(next: number) {
    setActive(next);
    if (next === 0 && list.current) {
      list.current.scrollTop = 0;
      return;
    }
    document
      .getElementById(`${listId}-${next}`)
      ?.scrollIntoView({ block: "nearest" });
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const count = Math.max(1, results.length);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move((selected + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move((selected - 1 + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        openInTab(results[selected]);
      } else {
        run(results[selected]);
      }
    }
  }
  return (
    <>
      <Dialog
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(next) => {
          if (!next) {
            setQuery("");
            setActive(0);
            observation.paletteClosed();
          }
        }}
        open={open}
      >
        <DialogContent
          className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
          initialFocus={input}
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Type a page, resource, namespace, cluster, workspace or action. Use
            the arrow keys and Enter to open, or Control or Command with Enter
            to open in a new tab.
          </DialogDescription>
          <div className="flex items-center gap-2 border-b px-3">
            <Search aria-hidden className="size-4 text-muted-foreground" />
            <input
              aria-activedescendant={
                results[selected] ? `${listId}-${selected}` : undefined
              }
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded="true"
              aria-label={title}
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => {
                setQuery(event.target.value);
                move(0);
              }}
              onKeyDown={keyDown}
              placeholder="Find resources, namespaces, clusters, pages or actions…"
              ref={input}
              role="combobox"
              value={query}
            />
            <kbd className="hidden rounded border px-1.5 py-0.5 text-muted-foreground text-xs sm:inline">
              Esc
            </kbd>
          </div>
          <div
            className="max-h-[min(60vh,420px)] overflow-y-auto p-1"
            id={listId}
            ref={list}
            role="listbox"
          >
            {groupsOf(results).map(([group, items]) => (
              // biome-ignore lint/a11y/useSemanticElements: ARIA listbox options are grouped with role=group, not a fieldset.
              <div
                aria-labelledby={`${listId}-${group}`}
                key={group}
                role="group"
              >
                <p
                  className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs"
                  id={`${listId}-${group}`}
                >
                  {group}
                </p>
                {items.map(({ result, index }) => (
                  <Option
                    id={`${listId}-${index}`}
                    key={result.id}
                    onHover={() => setActive(index)}
                    onRun={() => run(result)}
                    onTab={() => openInTab(result)}
                    result={result}
                    selected={index === selected}
                  />
                ))}
              </div>
            ))}
            {!results.length && (
              <p className="px-3 py-8 text-center text-muted-foreground text-sm">
                No page, observed resource or action matches “{query}”.
              </p>
            )}
          </div>
          <p className="border-t px-3 py-2 text-muted-foreground text-xs">
            Searches the loaded snapshot and the workspace list.{" "}
            {/* Phones have no new-tab shortcut; a tap opens. */}
            <span className="hidden sm:inline">
              Enter opens · Ctrl/⌘ Enter opens in a new tab.
            </span>
            <span className="sm:hidden">Tap a result to open it.</span>
          </p>
        </DialogContent>
      </Dialog>
      <ObservationTime
        at={display.at}
        onOpenChange={observation.setOpen}
        onSelect={(at) => navigate({ search: (old) => ({ ...old, at }) })}
        open={observation.open}
        triggerClassName="hidden"
      />
    </>
  );
}
