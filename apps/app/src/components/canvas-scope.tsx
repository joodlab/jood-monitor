import { Button } from "@jood-monitor/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@jood-monitor/ui/dropdown-menu";
import { Input } from "@jood-monitor/ui/input";
import { ChevronDown, ChevronLeft, FolderTree, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isSystemNamespace } from "../lib/infrastructure";

// The canvas scope, top left: a namespace pill (Railway's group switcher)
// with a way back to the namespace map, and a compact search that filters
// the cards.

const floating = "rounded-lg border bg-card/95 shadow-sm backdrop-blur";

function NamespacePill({
  namespace,
  namespaces,
  onNamespace,
}: {
  namespace: string;
  namespaces: string[];
  onNamespace: (namespace: string) => void;
}) {
  const all = namespace === "all";
  const label = all ? "All namespaces" : namespace;
  return (
    <div className={`flex h-9 min-w-0 items-center p-0.5 ${floating}`}>
      {!all && (
        <Button
          aria-label="Back to all namespaces"
          className="size-8 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onNamespace("all")}
          size="icon-sm"
          title="Back to all namespaces"
          variant="ghost"
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Namespace: ${label}`}
          className="flex h-8 min-w-0 max-w-56 items-center gap-1.5 rounded-md px-2 font-medium text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted"
        >
          <FolderTree
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="truncate">{label}</span>
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Namespaces</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={(value) => onNamespace(String(value))}
              value={namespace}
            >
              <DropdownMenuRadioItem value="all">
                All namespaces
              </DropdownMenuRadioItem>
              {namespaces.length > 0 && <DropdownMenuSeparator />}
              {namespaces.map((item) => (
                <DropdownMenuRadioItem key={item} value={item}>
                  <span className="min-w-0 flex-1 truncate">{item}</span>
                  {isSystemNamespace(item) && (
                    <span className="text-muted-foreground text-xs">
                      system
                    </span>
                  )}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Typing stays local and responsive; the URL (and therefore the canvas)
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

function CanvasSearch({
  value,
  onSearch,
}: {
  value: string;
  onSearch: (value: string) => void;
}) {
  const { draft, setDraft, flush } = useDraft(value, onSearch);
  return (
    <div className="relative w-44 sm:w-56">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        aria-label="Search the canvas"
        className={`h-9 pr-9 pl-8 text-sm focus-visible:ring-2 focus-visible:ring-ring dark:bg-card/95 [&::-webkit-search-cancel-button]:appearance-none ${floating}`}
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
        placeholder="Search resources"
        type="search"
        value={draft}
      />
      {draft && (
        <Button
          aria-label="Clear search"
          className="absolute top-1/2 right-0.5 -translate-y-1/2 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => flush("")}
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

export function CanvasScope({
  namespace,
  namespaces,
  onNamespace,
  q,
  onSearch,
}: {
  namespace: string;
  namespaces: string[];
  onNamespace: (namespace: string) => void;
  q: string;
  onSearch: (q: string) => void;
}) {
  return (
    <>
      <NamespacePill
        namespace={namespace}
        namespaces={namespaces}
        onNamespace={onNamespace}
      />
      <CanvasSearch onSearch={onSearch} value={q} />
    </>
  );
}
