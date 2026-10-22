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
import { Search, Square, SquareCheck, X } from "lucide-react";
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
  type ResourceTab,
} from "../lib/resource-table";
import type { SearchState } from "../schemas/monitor";

// One filter bar for every Resources tab. Filters edit the URL in place
// (replace), so Back leaves the page rather than undoing keystrokes. The kind
// filter appears on the All tab only, where it applies; every other tab is
// itself a kind, so no hidden value silently narrows its results. A filter
// that cannot apply is disabled and a visible note, linked with
// aria-describedby, says why. The cluster is chosen in the project bar.

type Update = (next: Partial<SearchState>, replace?: boolean) => void;

const COMMON_KINDS = "common";

const placeholders: Partial<Record<ResourceTab, string>> = {
  servers: "Search pods, workloads or servers…",
};

export function ResourceFilterBar({
  search,
  update,
  views,
  namespaces,
  tab,
}: {
  search: SearchState;
  update: Update;
  views: ClusterView[];
  namespaces: string[];
  tab: ResourceTab;
}) {
  const listMode = tab === "all";
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
  const systemNote = useId();
  const systemNamespace = isSystemNamespace(search.namespace);
  const notes: FilterNote[] = [];
  if (systemNamespace) {
    notes.push({
      id: systemNote,
      text: "System resources are shown because a system namespace is selected.",
    });
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <SearchField
          onCommit={(q) => replace({ q })}
          placeholder={placeholders[tab]}
          value={search.q}
        />
        <NamespaceSelect
          // Alone on its row on phones when the kind filter is absent.
          className={listMode ? undefined : "col-span-2"}
          namespaces={namespaces}
          onChange={(namespace) => replace({ namespace })}
          value={search.namespace}
        />
        {listMode && (
          <KindSelect
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
  placeholder = "Search name, kind, namespace, status…",
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
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
        placeholder={placeholder}
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

function NamespaceSelect({
  namespaces,
  value,
  onChange,
  className,
}: {
  namespaces: string[];
  value: string;
  onChange: (namespace: string) => void;
  className?: string;
}) {
  return (
    <Select onValueChange={(next) => onChange(next ?? "all")} value={value}>
      <SelectTrigger
        aria-label="Namespace"
        className={cn(selectClass, className)}
      >
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
  onChange,
}: {
  value?: string;
  summary?: KindSummary;
  onChange: (kind?: string) => void;
}) {
  return (
    <Select
      onValueChange={(next) =>
        onChange(next === COMMON_KINDS || !next ? undefined : next)
      }
      value={value ?? COMMON_KINDS}
    >
      <SelectTrigger aria-label="Kind" className={selectClass}>
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
