import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  getEventsFn,
  getSnapshotFn,
  getWorkspacesFn,
} from "../../functions/clusters";
import type { SearchState } from "../../schemas/monitor";

export function fetchSnapshot(workspace: string, at?: string) {
  return getSnapshotFn({ data: { workspace, at } });
}
export function fetchWorkspaces() {
  return getWorkspacesFn();
}
export function fetchEvents(search: SearchState) {
  const end = search.at ? Date.parse(search.at) : Date.now();
  return getEventsFn({
    data: {
      workspace: search.workspace,
      cluster: search.cluster,
      from: new Date(end - Number(search.range) * 3_600_000).toISOString(),
      to: search.at,
    },
  });
}

export function useMonitoringStream(search: SearchState) {
  const client = useQueryClient();
  const [connection, setConnection] = useState("connecting");
  const scope = search.workspace,
    frozen = !!search.at;
  useEffect(() => {
    if (frozen) {
      setConnection("frozen");
      return;
    }
    setConnection("connecting");
    let stopped = false,
      socket: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined,
      lastRefresh = 0;
    const invalidate = () => {
      lastRefresh = Date.now();
      for (const key of ["snapshot", "history", "events"]) {
        client.invalidateQueries(
          { queryKey: [key, scope] },
          { cancelRefetch: false }
        );
      }
    };
    const update = () => {
      if (refresh || document.visibilityState !== "visible") {
        return;
      }
      refresh = setTimeout(
        () => {
          refresh = undefined;
          if (document.visibilityState === "visible") {
            invalidate();
          }
        },
        Math.max(0, 30_000 - (Date.now() - lastRefresh))
      );
    };
    const connect = () => {
      if (stopped) {
        return;
      }
      const url = new URL("/api/v1/stream", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("workspace", scope);
      socket = new WebSocket(url);
      socket.onopen = () => {
        setConnection("connected");
      };
      socket.onmessage = (event) => {
        if (event.data === "pong") {
          return;
        }
        try {
          const message = JSON.parse(event.data) as { type: string };
          if (["change", "reload"].includes(message.type)) {
            update();
          }
        } catch {
          /* A malformed notification does not replace saved observations. */
        }
      };
      socket.onerror = () => setConnection("reconnecting");
      socket.onclose = () => {
        if (!stopped) {
          setConnection("reconnecting");
          reconnect = setTimeout(connect, 1500);
        }
      };
    };
    connect();
    document.addEventListener("visibilitychange", update);
    const ping = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send("ping");
      }
    }, 30_000);
    return () => {
      stopped = true;
      socket?.close();
      clearInterval(ping);
      clearTimeout(reconnect);
      clearTimeout(refresh);
      document.removeEventListener("visibilitychange", update);
    };
  }, [scope, frozen, client]);
  return connection;
}
