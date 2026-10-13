import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@jood-monitor/ui/table";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import {
  compactCpu,
  compactMemory,
  filterResources,
  type ResourceSummary,
  resourceStatus,
  summarize,
} from "../lib/infrastructure";
import { freshness } from "../lib/metrics";
import { StatusBadge } from "./resource-status";

interface Row {
  entity: Entity;
  summary: ResourceSummary;
  view: ClusterView;
}
export function Resources({
  views,
  search,
  onInspect,
  referenceTime,
  kinds,
  namespace = "all",
  showSystem = true,
}: {
  views: ClusterView[];
  search: string;
  onInspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  kinds?: string[];
  namespace?: string;
  showSystem?: boolean;
}) {
  const data = useMemo(
    () =>
      filterResources(views, search, namespace, showSystem)
        .filter(({ entity }) => !kinds || kinds.includes(entity.kind))
        .map((row) => ({
          ...row,
          summary: summarize(row.view, row.entity, referenceTime),
        })),
    [views, search, namespace, showSystem, kinds, referenceTime]
  );
  const columns: ColumnDef<Row>[] = [
    {
      id: "resource",
      header: "Resource",
      accessorFn: (r) => r.entity.name,
      cell: ({ row }) => (
        <Button
          className="h-auto max-w-64 justify-start p-0 text-left font-mono text-xs"
          onClick={() => onInspect(row.original.view, row.original.entity)}
          variant="link"
        >
          <span className="truncate">{row.original.entity.name}</span>
        </Button>
      ),
    },
    { id: "kind", header: "Kind", accessorFn: (r) => r.entity.kind },
    {
      id: "namespace",
      header: "Namespace",
      accessorFn: (r) => r.entity.namespace ?? "—",
    },
    {
      id: "status",
      header: "Observed status",
      accessorFn: (row) => resourceStatus(row.entity),
      cell: ({ row }) => (
        <StatusBadge
          entity={row.original.entity}
          stale={
            freshness(row.original.view.inventory.sourceTime, referenceTime) !==
            "fresh"
          }
        />
      ),
    },
    {
      id: "cpu",
      header: "CPU used",
      accessorFn: (row) => row.summary.cpu,
      sortUndefined: "last",
      cell: ({ row }) => compactCpu(row.original.summary.cpu),
    },
    {
      id: "memory",
      header: "Memory used",
      accessorFn: (row) => row.summary.memory,
      sortUndefined: "last",
      cell: ({ row }) => compactMemory(row.original.summary.memory),
    },
    {
      id: "ready",
      header: "Ready",
      accessorFn: (row) => row.summary.ready,
      sortUndefined: "last",
      cell: ({ row }) => {
        const summary = row.original.summary;
        return summary.ready == null || summary.desired == null
          ? "—"
          : `${summary.ready}/${summary.desired}`;
      },
    },
    {
      id: "freshness",
      header: "Inventory",
      accessorFn: (row) =>
        freshness(row.view.inventory.sourceTime, referenceTime),
      cell: ({ row }) =>
        freshness(row.original.view.inventory.sourceTime, referenceTime),
    },
  ];
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
  });
  return (
    <div className="space-y-3">
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((g) => (
              <TableRow key={g.id}>
                {g.headers.map((h) => (
                  <TableHead
                    aria-sort={sortDirection(h.column.getIsSorted())}
                    key={h.id}
                  >
                    <Button
                      onClick={h.column.getToggleSortingHandler()}
                      size="sm"
                      variant="ghost"
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </Button>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                className="text-xs"
                key={`${row.original.view.cluster.id}:${row.original.entity.uid}`}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!data.length && (
              <TableRow>
                <TableCell
                  className="h-32 text-center text-muted-foreground"
                  colSpan={8}
                >
                  No observed resources match this view
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {data.length} observed resources
        </p>
        <div className="flex gap-2">
          <Button
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
            size="sm"
            variant="outline"
          >
            Previous
          </Button>
          <Button
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
            size="sm"
            variant="outline"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function sortDirection(value: false | "asc" | "desc") {
  if (!value) {
    return "none" as const;
  }
  return value === "asc" ? ("ascending" as const) : ("descending" as const);
}
