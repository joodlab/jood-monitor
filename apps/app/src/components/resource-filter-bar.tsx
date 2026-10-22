import type { ClusterView } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Input } from "@jood-monitor/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import { cn } from "@jood-monitor/ui/utils";
import {
  List,
  type LucideIcon,
  Network,
  Search,
  Server,
  Square,
  SquareCheck,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { isSystemNamespace } from "../lib/infrastructure";
import {
  type KindSummary,
  kindSummary,
  type ResourceFilter,
} from "../lib/resource-table";
import type { SearchState } from "../schemas/monitor";

// One filter bar for Infrastructure and Workloads. Every filter stays
// visible; one that cannot apply to the current mode is disabled and a
// visible note, linked with aria-describedby, says why, so no hidden value
// silently narrows the results.

type Update = (next: Partial<SearchState>, replace?: boolean) => void;

const modes: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "services", label: "Topology", icon: Network },
  { id: "servers", label: "Servers", icon: Server },
  { id: "list", label: "List", icon: List },
];

const COMMON_KINDS = "common";

export function ResourceFilterBar({
  search,
  update,
  allViews,
  views,
  namespaces,
}: {
  search: SearchState;
  update: Update;
  allViews: ClusterView[];
  views: ClusterView[];
  namespaces: string[];
}) {
  const infrastructure = search.view === "infrastructure";
  const listMode = infrastructure && search.mode === "list";
  const kinds = useMemo(
    () =>
      listMode
        ? kindSummary(views, {
            q: search.q,
            namespace: search.namespace,
            system: search.system,
            problems: false,
          })
        : undefined,
    [listMode, views, search.q, search.namespace, search.system]
  );
  const replace = (next: Partial<SearchState>) => update(next, true);
  const kindNote = useId();
  const systemNote = useId();
  const systemNamespace = isSystemNamespace(search.namespace);
  const notes: FilterNote[] = [];
  if (infrastructure && !listMode) {
    notes.push({
      id: kindNote,
      text: "The kind filter applies to the List view.",
    });
  }
  if (systemNamespace) {
    notes.push({
      id: systemNote,
      text: "System resources are shown because a system namespace is selected.",
    });
  }
  return (
    <div className="space-y-2">
      {infrastructure && (
        <ModeSwitch mode={search.mode} onMode={(mode) => update({ mode })} />
      )}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <SearchField onCommit={(q) => replace({ q })} value={search.q} />
        <ClusterSelect
          allViews={allViews}
          onChange={(cluster) => replace({ cluster, namespace: "all" })}
          value={search.cluster}
        />
        <NamespaceSelect
          namespaces={namespaces}
          onChange={(namespace) => replace({ namespace })}
          value={search.namespace}
        />
        {infrastructure && (
          <KindSelect
            describedBy={listMode ? undefined : kindNote}
            disabled={!listMode}
            onChange={(kind) => replace({ kind })}
            summary={kinds}
            value={search.kind}
          />
        )}
        <FilterToggle
          describedBy={systemNamespace ? systemNote : undefined}
          disabled={systemNamespace}
          onChange={(system) => replace({ system })}
          pressed={search.system || systemNamespace}
        >
          System resources
        </FilterToggle>
        <FilterToggle
          onChange={(problems) => replace({ problems })}
          pressed={search.problems}
        >
          Problems only
        </FilterToggle>
      </div>
      <FilterNotes notes={notes} />
      <ActiveFilters
        kinds={listMode ? kinds : undefined}
        onClear={(patch) => replace(patch)}
        search={search}
      />
    </div>
  );
}

function ModeSwitch({
  mode,
  onMode,
}: {
  mode: string;
  onMode: (mode: string) => void;
}) {
  return (
    <fieldset className="m-0 grid w-full min-w-0 grid-cols-3 rounded-lg border bg-card p-0.5 sm:inline-grid sm:w-auto">
      <legend className="sr-only">Infrastructure view</legend>
      {modes.map((item) => {
        const active = mode === item.id;
        return (
          <Button
            aria-pressed={active}
            className={cn(
              "h-9 gap-1.5 text-sm sm:h-8 sm:px-3",
              active && "shadow-xs"
            )}
            key={item.id}
            onClick={() => onMode(item.id)}
            size="sm"
            variant={active ? "secondary" : "ghost"}
          >
            <item.icon aria-hidden className="size-4" />
            {item.label}
          </Button>
        );
      })}
    </fieldset>
  );
}

// Typing stays local and responsive; the URL (and therefore filtering)
// follows 200 ms after the last keystroke without adding history entries.
function useDraft(value: string, commit: (value: string) => void) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const latest = useRef(commit);
  useEffect(() => {
    latest.current = commit;
  }, [commit]);
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    if (draft === committed.current) {
      return;
    }
    const timer = setTimeout(() => {
      committed.current = draft;
      latest.current(draft);
    }, 200);
    return () => clearTimeout(timer);
  }, [draft]);
  const flush = (next = draft) => {
    committed.current = next;
    setDraft(next);
    latest.current(next);
  };
  return { draft, setDraft, flush };
}

function SearchField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const { draft, setDraft, flush } = useDraft(value, onCommit);
  return (
    <div className="relative col-span-2 sm:min-w-56 sm:flex-1">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        aria-label="Search resources"
        className="h-9 pr-9 pl-8 text-sm sm:h-8 [&::-webkit-search-cancel-button]:appearance-none"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            flush();
          }
          if (event.key === "Escape" && draft) {
            event.preventDefault();
            flush("");
          }
        }}
        placeholder="Search name, kind, namespace, status…"
        type="search"
        value={draft}
      />
      {draft && (
        <Button
          aria-label="Clear search"
          className="absolute top-1/2 right-0.5 -translate-y-1/2"
          onClick={() => flush("")}
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

const selectClass = "h-9 w-full text-xs sm:h-8 sm:w-44";

function ClusterSelect({
  allViews,
  value,
  onChange,
}: {
  allViews: ClusterView[];
  value?: string;
  onChange: (cluster?: string) => void;
}) {
  return (
    <Select
      onValueChange={(next) =>
        onChange(next === "all" || !next ? undefined : next)
      }
      value={value ?? "all"}
    >
      <SelectTrigger aria-label="Cluster" className={selectClass}>
        <SelectValue>
          {value
            ? (allViews.find((view) => view.cluster.id === value)?.cluster
                .name ?? value)
            : "All clusters"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All clusters</SelectItem>
        {allViews.map((view) => (
          <SelectItem key={view.cluster.id} value={view.cluster.id}>
            {view.cluster.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NamespaceSelect({
  namespaces,
  value,
  onChange,
}: {
  namespaces: string[];
  value: string;
  onChange: (namespace: string) => void;
}) {
  return (
    <Select onValueChange={(next) => onChange(next ?? "all")} value={value}>
      <SelectTrigger aria-label="Namespace" className={selectClass}>
        <SelectValue>{value === "all" ? "All namespaces" : value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All namespaces</SelectItem>
        {namespaces.map((namespace) => (
          <SelectItem key={namespace} value={namespace}>
            {namespace}
            {isSystemNamespace(namespace) && (
              <span className="text-muted-foreground text-xs">system</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function kindLabel(value?: string) {
  if (!value) {
    return "Common kinds";
  }
  return value === "all" ? "All kinds" : value;
}

interface FilterNote {
  id: string;
  text: string;
}

// Why a filter is disabled, as visible text rather than a hover tooltip, so
// touch, keyboard and screen-reader users get the same explanation.
function FilterNotes({ notes }: { notes: FilterNote[] }) {
  if (!notes.length) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
      {notes.map((note) => (
        <p id={note.id} key={note.id}>
          {note.text}
        </p>
      ))}
    </div>
  );
}

function KindSelect({
  value,
  summary,
  disabled,
  describedBy,
  onChange,
}: {
  value?: string;
  summary?: KindSummary;
  disabled: boolean;
  describedBy?: string;
  onChange: (kind?: string) => void;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) =>
        onChange(next === COMMON_KINDS || !next ? undefined : next)
      }
      value={value ?? COMMON_KINDS}
    >
      <SelectTrigger
        aria-describedby={describedBy}
        aria-label="Kind"
        className={selectClass}
      >
        <SelectValue>{kindLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={COMMON_KINDS}>
          Common kinds
          {summary?.hiddenCount ? (
            <span className="text-muted-foreground text-xs">
              hides {summary.hidden.length}
            </span>
          ) : null}
        </SelectItem>
        <SelectItem value="all">All kinds</SelectItem>
        {!!summary?.kinds.length && <SelectSeparator />}
        {summary?.kinds.map((item) => (
          <SelectItem key={item.kind} value={item.kind}>
            {item.kind}
            <span className="text-muted-foreground text-xs tabular-nums">
              {item.count}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FilterToggle({
  pressed,
  onChange,
  disabled = false,
  describedBy,
  children,
}: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  disabled?: boolean;
  // The visible note that explains a disabled toggle.
  describedBy?: string;
  children: ReactNode;
}) {
  const Icon = pressed ? SquareCheck : Square;
  return (
    <Button
      aria-describedby={describedBy}
      aria-pressed={pressed}
      className="h-9 w-full justify-start text-xs sm:h-8 sm:w-auto"
      disabled={disabled}
      onClick={() => onChange(!pressed)}
      size="sm"
      variant={pressed ? "secondary" : "outline"}
    >
      <Icon aria-hidden className="size-3.5" />
      {children}
    </Button>
  );
}

interface Chip {
  key: string;
  label: string;
  patch: Partial<SearchState>;
}

function activeChips(search: SearchState, kinds?: KindSummary): Chip[] {
  const chips: Chip[] = [];
  if (search.q) {
    chips.push({ key: "q", label: `Search “${search.q}”`, patch: { q: "" } });
  }
  if (search.namespace !== "all") {
    chips.push({
      key: "namespace",
      label: `Namespace ${search.namespace}`,
      patch: { namespace: "all" },
    });
  }
  if (search.system) {
    chips.push({
      key: "system",
      label: "Including system",
      patch: { system: false },
    });
  }
  if (search.problems) {
    chips.push({
      key: "problems",
      label: "Problems only",
      patch: { problems: false },
    });
  }
  if (kinds && search.kind) {
    chips.push({
      key: "kind",
      label: search.kind === "all" ? "All kinds" : `Kind ${search.kind}`,
      patch: { kind: undefined },
    });
  }
  return chips;
}

const clearAll: Partial<SearchState> & Partial<ResourceFilter> = {
  q: "",
  namespace: "all",
  system: false,
  problems: false,
  kind: undefined,
};

function ActiveFilters({
  search,
  kinds,
  onClear,
}: {
  search: SearchState;
  kinds?: KindSummary;
  onClear: (patch: Partial<SearchState>) => void;
}) {
  const chips = activeChips(search, kinds);
  const hiding = kinds && !search.kind && kinds.hiddenCount > 0;
  if (!(chips.length || hiding)) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
      {chips.length > 0 && <span>Filtered by</span>}
      {chips.map((chip) => (
        <Button
          aria-label={`Remove filter: ${chip.label}`}
          className="h-8 max-w-64 gap-1 rounded-full text-xs"
          key={chip.key}
          onClick={() => onClear(chip.patch)}
          size="sm"
          variant="secondary"
        >
          <span className="truncate">{chip.label}</span>
          <X aria-hidden className="size-3" />
        </Button>
      ))}
      {chips.length > 0 && (
        <Button
          className="h-8 text-xs"
          onClick={() => onClear(clearAll)}
          size="sm"
          variant="ghost"
        >
          Clear filters
        </Button>
      )}
      {hiding && kinds && (
        <span className="flex flex-wrap items-center gap-1">
          <span title={kinds.hidden.map((item) => item.kind).join(", ")}>
            {kinds.hiddenCount} resources in {kinds.hidden.length} hidden kind
            {kinds.hidden.length === 1 ? "" : "s"} (
            {kinds.hidden.map((item) => item.kind).join(", ")})
          </span>
          <Button
            className="h-8 text-xs"
            onClick={() => onClear({ kind: "all" })}
            size="sm"
            variant="link"
          >
            Show all kinds
          </Button>
        </span>
      )}
    </div>
  );
}
