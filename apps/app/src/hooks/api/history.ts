import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { useQuery } from "@tanstack/react-query";
import { historyRefetchInterval } from "../../components/inspector-model";
import type { SeriesHistory } from "../../contracts/types";
import { getSeriesHistoryFn } from "../../functions/clusters";
import { historyError } from "../../lib/install-errors";
import { rawRetentionMessage } from "../../lib/retention";
import {
  type HubClock,
  hubNow,
  observationMs,
  rawWindow,
} from "../../lib/time";
import type { seriesNames } from "../../schemas/clusters";

type Inspected = { view: ClusterView; entity: Entity } | null;
export type SeriesName = (typeof seriesNames)[number];

export interface SeriesWindow {
  at?: string;
  connection?: string;
  // The snapshot's hub time; the 7-day raw boundary is measured from it.
  hubClock?: HubClock;
  range: string;
  referenceTime: number;
  scope?: string;
}

// One bounded read and the window it covers: exactly the queried interval,
// ending at the saved observation when frozen and starting no earlier than
// the hub's raw retention.
export interface SeriesRead {
  clamped: boolean;
  from: number;
  response: SeriesHistory;
  to: number;
}

// Raw series for a few entities and metric names in one request. Charts that
// read the same entities and names share the key, so one read serves them;
// `part` keeps independent sections apart, so one refusal cannot break
// another section.
export function useSeriesHistory<T = SeriesRead>({
  inspected,
  entities,
  names,
  window: { at, connection, hubClock, scope, range, referenceTime },
  part,
  enabled = true,
  select,
}: {
  inspected: Inspected;
  entities: readonly string[];
  names: readonly SeriesName[];
  window: SeriesWindow;
  part: string;
  enabled?: boolean;
  select?: (read: SeriesRead) => T;
}) {
  const workspace = inspected?.view.cluster.workspaceId;
  const cluster = inspected?.view.cluster.id;
  return useQuery({
    // The scope leads the key so the stream's per-scope invalidation
    // reaches it, including the all-workspaces view.
    queryKey: [
      "history",
      scope ?? workspace,
      workspace,
      cluster,
      entities.join(","),
      names.join(","),
      range,
      at ?? "live",
      "series",
      part,
    ],
    enabled: enabled && !!inspected && entities.length > 0 && referenceTime > 0,
    refetchInterval: historyRefetchInterval(at, connection),
    retry: (failures, error) =>
      failures < 1 && historyError(error, !!at).retryable,
    select,
    queryFn: async (): Promise<SeriesRead> => {
      const hubTime = hubNow(hubClock, Date.now());
      // Live, the hub ends the window at its own now, so the start is
      // measured from the hub's clock too: a browser clock running ahead
      // would otherwise ask for a window that has not begun.
      const to = at ? observationMs(at) : (hubTime ?? Date.now());
      if (to == null) {
        throw new Error("invalid timestamp");
      }
      const bounds = rawWindow(to, Number(range), hubTime);
      // A request the hub would refuse is not sent; it fails the same way.
      if (bounds.outside) {
        throw new Error(rawRetentionMessage);
      }
      const response = await getSeriesHistoryFn({
        data: {
          workspace: workspace ?? "",
          cluster: cluster ?? "",
          entities: [...entities],
          names: [...names],
          from: new Date(bounds.from).toISOString(),
          to: at,
        },
      });
      return {
        response,
        from: bounds.from,
        to: bounds.to,
        clamped: bounds.clamped,
      };
    },
  });
}
