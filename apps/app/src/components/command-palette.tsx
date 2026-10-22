import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@jood-monitor/ui/dialog";
import { cn } from "@jood-monitor/ui/utils";
import { CornerDownLeft, Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import { resourceStatus } from "../lib/infrastructure";

// Keyboard-first jump to any page, cluster or observed resource (⌘K / Ctrl+K
// or "/"). Results come from the already loaded snapshot; nothing is fetched.

export interface PaletteTarget {
  id: string;
  label: string;
  run: () => void;
}

interface Result {
  detail: string;
  group: string;
  id: string;
  label: string;
  run: () => void;
  score: number;
}

const searchable = new Set([
  "Node",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Service",
  "Ingress",
  "Pod",
  "Namespace",
]);

function score(text: string, query: string) {
  const value = text.toLowerCase();
  if (value === query) {
    return 0;
  }
  if (value.startsWith(query)) {
    return 1;
  }
  return value.includes(query) ? 2 : -1;
}

interface Sources {
  onCluster: (view: ClusterView) => () => void;
  onInspect: (view: ClusterView, entity: Entity) => () => void;
  pages: PaletteTarget[];
  views: ClusterView[];
}

function pageResults(term: string, pages: PaletteTarget[]): Result[] {
  return pages.flatMap((page) => {
    const value = term ? score(page.label, term) : 1;
    return value < 0
      ? []
      : [
          {
            id: `page:${page.id}`,
            group: "Pages",
            label: page.label,
            detail: "Go to page",
            run: page.run,
            score: value,
          },
        ];
  });
}

function clusterResults(term: string, sources: Sources): Result[] {
  return sources.views.flatMap((view) => {
    const value = term ? score(view.cluster.name, term) : 1;
    return value < 0
      ? []
      : [
          {
            id: `cluster:${view.cluster.id}`,
            group: "Clusters",
            label: view.cluster.name,
            detail: `${view.cluster.environment} · show this cluster's servers`,
            run: sources.onCluster(view),
            score: value,
          },
        ];
  });
}

function entityScore(entity: Entity, term: string) {
  const values = [
    entity.name,
    `${entity.namespace ?? ""}/${entity.name}`,
    ...(entity.addresses ?? []),
  ].map((text) => score(text, term));
  const matched = values.filter((value) => value >= 0);
  return matched.length ? Math.min(...matched) : -1;
}

function entityResults(term: string, sources: Sources): Result[] {
  if (!term) {
    return [];
  }
  return sources.views.flatMap((view) =>
    view.inventory.entities.flatMap((entity) => {
      const value = searchable.has(entity.kind)
        ? entityScore(entity, term)
        : -1;
      if (value < 0) {
        return [];
      }
      return [
        {
          id: `entity:${view.cluster.id}:${entity.uid}`,
          group: "Resources",
          label: entity.name,
          detail: [
            entity.kind,
            entity.namespace,
            sources.views.length > 1 ? view.cluster.name : "",
            resourceStatus(entity),
          ]
            .filter(Boolean)
            .join(" · "),
          run: sources.onInspect(view, entity),
          score: value + 0.5,
        },
      ];
    })
  );
}

// Results are ordered by group, then match quality, so arrow keys follow the
// visual order. Typed searches put resources first.
function searchResults(term: string, sources: Sources) {
  const order = term
    ? ["Resources", "Clusters", "Pages"]
    : ["Pages", "Clusters", "Resources"];
  return [
    ...pageResults(term, sources.pages),
    ...clusterResults(term, sources),
    ...entityResults(term, sources),
  ]
    .sort(
      (a, b) =>
        order.indexOf(a.group) - order.indexOf(b.group) ||
        a.score - b.score ||
        a.label.localeCompare(b.label)
    )
    .slice(0, 50);
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
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);
  const results = useMemo(() => {
    const close = (run: () => void) => () => {
      onOpenChange(false);
      run();
    };
    return searchResults(query.trim().toLowerCase(), {
      pages: pages.map((page) => ({ ...page, run: close(page.run) })),
      views,
      onCluster: (view) => close(() => onCluster(view)),
      onInspect: (view, entity) => close(() => onInspect(view, entity)),
    });
  }, [query, pages, views, onInspect, onCluster, onOpenChange]);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((selected + 1) % Math.max(1, results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((selected - 1 + results.length) % Math.max(1, results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      results[selected]?.run();
    }
  }
  const groups = [
    ...results
      .reduce((map, result, index) => {
        map.set(result.group, [
          ...(map.get(result.group) ?? []),
          { result, index },
        ]);
        return map;
      }, new Map<string, { result: Result; index: number }[]>())
      .entries(),
  ];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Find a page or resource</DialogTitle>
        <DialogDescription className="sr-only">
          Type a name, namespace or kind. Use the arrow keys and Enter to open.
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
            aria-label="Find a page or resource"
            autoFocus
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={keyDown}
            placeholder="Find servers, workloads, pods, services, clusters…"
            role="combobox"
            value={query}
          />
          <kbd className="hidden rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline">
            Esc
          </kbd>
        </div>
        <div
          className="max-h-[min(60vh,420px)] overflow-y-auto p-1"
          id={listId}
          role="listbox"
        >
          {groups.map(([group, items]) => (
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
                // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns keyboard selection.
                <div
                  aria-selected={index === selected}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm",
                    index === selected && "bg-muted"
                  )}
                  id={`${listId}-${index}`}
                  key={result.id}
                  onClick={result.run}
                  onMouseMove={() => setActive(index)}
                  role="option"
                  tabIndex={-1}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13px]">
                      {result.label}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {result.detail}
                    </span>
                  </span>
                  {index === selected && (
                    <CornerDownLeft
                      aria-hidden
                      className="size-3.5 text-muted-foreground"
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
          {!results.length && (
            <p className="px-3 py-8 text-center text-muted-foreground text-sm">
              No page or observed resource matches “{query}”.
            </p>
          )}
        </div>
        <p className="border-t px-3 py-2 text-muted-foreground text-xs">
          Searches the loaded snapshot of the selected workspace.
        </p>
      </DialogContent>
    </Dialog>
  );
}
