import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@jood-monitor/ui/table";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type Header,
  type Row,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  SearchX,
} from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clampPage,
  type HiddenMatches,
  hiddenMatches,
  pageRange,
  presetFor,
  type ResourceFilter,
  type ResourceRow,
  resourceRows,
  type TablePreset,
} from "../lib/resource-table";
import { defaultPageSize, pageSizes } from "../schemas/monitor";
import { EmptyState } from "./page";
import { cardFacts, resourceColumns } from "./resource-columns";
import { StatusBadge } from "./resource-status";

const nouns: Record<TablePreset, [string, string]> = {
  list: ["resource", "resources"],
  nodes: ["server", "servers"],
  pods: ["pod", "pods"],
  services: ["service", "services"],
  workloads: ["workload", "workloads"],
};

export function Resources({
  views,
  search,
  onInspect,
  referenceTime,
  kinds,
  namespace = "all",
  showSystem = true,
  problems = false,
  kind,
  preset,
  pageSize,
  onPageSizeChange,
  onRelax,
}: {
  views: ClusterView[];
  search: string;
  onInspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  // Restricts rows to these kinds; the list kind filter then does not apply.
  kinds?: string[];
  namespace?: string;
  showSystem?: boolean;
  problems?: boolean;
  // List kind filter: absent hides noisy kinds, "all" shows every kind.
  kind?: string;
  preset?: TablePreset;
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
  // Relaxes one filter when every match is hidden by it.
  onRelax?: (patch: Partial<ResourceFilter>) => void;
}) {
  const filter = useMemo<ResourceFilter>(
    () => ({ q: search, namespace, system: showSystem, problems, kind }),
    [search, namespace, showSystem, problems, kind]
  );
  const kindKey = kinds?.join(",");
  const scopeKinds = useMemo(() => kindKey?.split(","), [kindKey]);
  const table = preset ?? presetFor(scopeKinds);
  const data = useMemo(
    () => resourceRows(views, filter, referenceTime, scopeKinds),
    [views, filter, referenceTime, scopeKinds]
  );
  const hidden = useMemo(
    () =>
      data.length
        ? undefined
        : hiddenMatches(views, filter, referenceTime, scopeKinds),
    [data.length, views, filter, referenceTime, scopeKinds]
  );
  const scope = [
    JSON.stringify(filter),
    kindKey,
    table,
    views.map((view) => view.cluster.id).join(","),
  ].join("|");
  return (
    <ResourceTable
      data={data}
      hidden={hidden}
      multiCluster={views.length > 1}
      onInspect={onInspect}
      onPageSizeChange={onPageSizeChange}
      onRelax={onRelax}
      pageSize={pageSize}
      preset={table}
      scope={scope}
    />
  );
}

// Keeps the latest inspect callback without changing column identity.
function useStableInspect(
  onInspect: (view: ClusterView, entity: Entity) => void
) {
  const latest = useRef(onInspect);
  useEffect(() => {
    latest.current = onInspect;
  }, [onInspect]);
  return useCallback(
    (view: ClusterView, entity: Entity) => latest.current(view, entity),
    []
  );
}

// Page position survives refreshes; it resets only when the scope (filters,
// tab, clusters) or the sort changes, and clamps when rows disappear.
function usePagination(scope: string, controlledSize?: number) {
  const [pageIndex, setPageIndex] = useState(0);
  const [localSize, setLocalSize] = useState<number>(defaultPageSize);
  const [lastScope, setLastScope] = useState(scope);
  if (lastScope !== scope) {
    setLastScope(scope);
    setPageIndex(0);
  }
  return {
    pageIndex,
    setPageIndex,
    pageSize: controlledSize ?? localSize,
    setLocalSize,
  };
}

function ResourceTable({
  data,
  preset,
  hidden,
  multiCluster,
  onInspect,
  pageSize: controlledSize,
  onPageSizeChange,
  onRelax,
  scope,
}: {
  data: ResourceRow[];
  preset: TablePreset;
  hidden?: HiddenMatches;
  multiCluster: boolean;
  onInspect: (view: ClusterView, entity: Entity) => void;
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
  onRelax?: (patch: Partial<ResourceFilter>) => void;
  scope: string;
}) {
  const inspect = useStableInspect(onInspect);
  const columns = useMemo(
    () => resourceColumns(preset, { onInspect: inspect, multiCluster }),
    [preset, inspect, multiCluster]
  );
  const [sorting, setSorting] = useState<SortingState>([]);
  const page = usePagination(scope, controlledSize);
  const pageIndex = clampPage(page.pageIndex, page.pageSize, data.length);
  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: false,
    state: { sorting, pagination: { pageIndex, pageSize: page.pageSize } },
    onSortingChange: (updater) => {
      setSorting(updater);
      page.setPageIndex(0);
    },
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater({ pageIndex, pageSize: page.pageSize })
          : updater;
      page.setPageIndex(next.pageIndex);
    },
  });
  if (!data.length) {
    return <NoRows hidden={hidden} onRelax={onRelax} preset={preset} />;
  }
  const rows = table.getRowModel().rows;
  const changeSize = (size: number) => {
    page.setPageIndex(0);
    if (onPageSizeChange) {
      onPageSizeChange(size);
    } else {
      page.setLocalSize(size);
    }
  };
  return (
    <div className="space-y-3">
      <div className="hidden overflow-hidden rounded-lg border sm:block">
        <Table>
          <TableHeader className="bg-muted/30">
            {table.getHeaderGroups().map((group) => (
              <TableRow className="hover:bg-transparent" key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    aria-sort={
                      header.column.getCanSort()
                        ? sortDirection(header.column.getIsSorted())
                        : undefined
                    }
                    className="text-xs"
                    key={header.id}
                  >
                    <SortHeader header={header} />
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <ResourceTableRow inspect={inspect} key={row.id} row={row} />
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="space-y-2 sm:hidden">
        {rows.map((row) => (
          <li key={row.id}>
            <ResourceCard
              inspect={inspect}
              preset={preset}
              row={row.original}
            />
          </li>
        ))}
      </ul>
      <Pager
        noun={nouns[preset]}
        onNext={() => table.nextPage()}
        onPageSize={changeSize}
        onPrevious={() => table.previousPage()}
        pageIndex={pageIndex}
        pageSize={page.pageSize}
        sorted={sorting.length > 0}
        total={data.length}
      />
    </div>
  );
}

function ResourceTableRow({
  row,
  inspect,
}: {
  row: Row<ResourceRow>;
  inspect: (view: ClusterView, entity: Entity) => void;
}) {
  // The whole row opens the inspector for pointer users; keyboard users reach
  // the same action through the row's name button, so no nested roles.
  function open(event: MouseEvent<HTMLTableRowElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, a") || window.getSelection()?.toString()) {
      return;
    }
    inspect(row.original.view, row.original.entity);
  }
  return (
    <TableRow
      className="cursor-pointer text-sm data-[problem=true]:bg-warning/5"
      data-problem={row.original.problem}
      onClick={open}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
}

function SortHeader({ header }: { header: Header<ResourceRow, unknown> }) {
  const label = flexRender(header.column.columnDef.header, header.getContext());
  if (!header.column.getCanSort()) {
    return <span className="font-medium text-muted-foreground">{label}</span>;
  }
  const sorted = header.column.getIsSorted();
  let Icon = ChevronsUpDown;
  if (sorted) {
    Icon = sorted === "asc" ? ArrowUp : ArrowDown;
  }
  return (
    <Button
      className="-ml-2 h-8 px-2 font-medium text-muted-foreground text-xs data-[sorted=true]:text-foreground"
      data-sorted={!!sorted}
      onClick={header.column.getToggleSortingHandler()}
      size="sm"
      variant="ghost"
    >
      {label}
      <Icon
        aria-hidden
        className={sorted ? "size-3.5" : "size-3.5 opacity-50"}
      />
    </Button>
  );
}

function ResourceCard({
  row,
  preset,
  inspect,
}: {
  row: ResourceRow;
  preset: TablePreset;
  inspect: (view: ClusterView, entity: Entity) => void;
}) {
  return (
    <button
      className="w-full rounded-lg border bg-card p-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 data-[problem=true]:border-warning/40"
      data-problem={row.problem}
      onClick={() => inspect(row.view, row.entity)}
      type="button"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate font-medium font-mono text-sm">
            {row.entity.name}
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {row.entity.kind} · {row.view.cluster.name}
          </span>
        </span>
        <StatusBadge entity={row.entity} problem={row.problem} />
      </span>
      <span className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        {cardFacts(row, preset).map((fact) => (
          <span className="min-w-0" key={fact.label}>
            <span className="block text-muted-foreground">{fact.label}</span>
            <span className="block truncate">{fact.value ?? "—"}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

function Pager({
  total,
  pageIndex,
  pageSize,
  noun,
  sorted,
  onPrevious,
  onNext,
  onPageSize,
}: {
  total: number;
  pageIndex: number;
  pageSize: number;
  noun: [string, string];
  sorted: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPageSize: (size: number) => void;
}) {
  const { from, to } = pageRange(pageIndex, pageSize, total);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const paged = total > pageSizes[0];
  const sizeLabel = useId();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-xs">
      <p aria-live="polite" className="tabular-nums">
        {paged
          ? `Rows ${from}–${to} of ${total} ${noun[1]}`
          : `${total} ${total === 1 ? noun[0] : noun[1]}`}
        {!sorted && " · problems first, then name"}
      </p>
      {paged && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5">
            <span id={sizeLabel}>Rows per page</span>
            <Select
              onValueChange={(value) => onPageSize(Number(value))}
              value={String(pageSize)}
            >
              <SelectTrigger
                aria-labelledby={sizeLabel}
                className="w-20 text-xs"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
          <Button
            aria-label="Previous page"
            className="h-9 sm:h-8"
            disabled={pageIndex === 0}
            onClick={onPrevious}
            size="sm"
            variant="outline"
          >
            <ChevronLeft aria-hidden />
            <span className="hidden sm:inline">Previous</span>
          </Button>
          <span className="tabular-nums">
            Page {pageIndex + 1} of {pages}
          </span>
          <Button
            aria-label="Next page"
            className="h-9 sm:h-8"
            disabled={pageIndex >= pages - 1}
            onClick={onNext}
            size="sm"
            variant="outline"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

function NoRows({
  hidden,
  preset,
  onRelax,
}: {
  hidden?: HiddenMatches;
  preset: TablePreset;
  onRelax?: (patch: Partial<ResourceFilter>) => void;
}) {
  return (
    <EmptyState
      description={
        hidden?.message ?? "Nothing observed matches the current filters."
      }
      icon={SearchX}
      title={`No ${nouns[preset][1]} match`}
    >
      {hidden && onRelax && (
        <Button
          className="h-9 sm:h-8"
          onClick={() => onRelax(hidden.patch)}
          size="sm"
          variant="outline"
        >
          {hidden.action}
        </Button>
      )}
    </EmptyState>
  );
}

function sortDirection(value: false | "asc" | "desc") {
  if (!value) {
    return "none" as const;
  }
  return value === "asc" ? ("ascending" as const) : ("descending" as const);
}
