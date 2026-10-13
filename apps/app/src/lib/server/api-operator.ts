import { exportArchives } from "../../actions/archives/export";
import {
  alterCredential,
  getEvents,
  getHistory,
  getSnapshot,
  recoverEnrollment,
  registerCluster,
  registerWorkspace,
  requireCluster,
  unwrap,
  updateProfile,
  workspaces,
} from "../../actions/clusters";
import type { StoredMetric } from "../../contracts/types";
import { clusterState, type Env } from "../../env";
import {
  clusterSchema,
  eventsSchema,
  historySchema,
  profileSchema,
  snapshotSchema,
  workspaceSchema,
} from "../../schemas/clusters";
import { requireBrowserOrigin } from "./auth";
import { HttpError, json, readJson } from "./http";
import { encodeTelemetry, openMetrics } from "./telemetry";

const controlRoute =
  /^\/api\/v1\/clusters\/([a-z0-9-]{1,64})\/(profile|enrollment|rotate|revoke|status)$/;

async function controlApi(request: Request, env: Env, path: string) {
  const control = controlRoute.exec(path);
  if (!control) {
    throw new HttpError(404, "operator route missing");
  }
  const cluster = await requireCluster(env, control[1]);
  if (control[2] === "status" && request.method === "GET") {
    return json(
      unwrap(
        await clusterState(env, cluster.id).command(cluster, "status", null)
      )
    );
  }
  if (request.method !== "POST") {
    throw new HttpError(405, "method unsupported");
  }
  switch (control[2]) {
    case "profile":
      return json(
        await updateProfile(
          env,
          cluster.id,
          profileSchema.parse(await readJson(request))
        )
      );
    case "enrollment":
      return json(await recoverEnrollment(env, cluster.id), 201);
    case "rotate":
      return json(await alterCredential(env, cluster.id, false));
    case "revoke":
      return json(await alterCredential(env, cluster.id, true));
    default:
      throw new HttpError(405, "method unsupported");
  }
}

async function exportApi(env: Env, path: string, workspace: string) {
  const snapshot = await getSnapshot(env, snapshotSchema.parse({ workspace }));
  const rows = snapshot.clusters.flatMap((c) => c.metrics) as StoredMetric[];
  const text = path === "/metrics";
  return new Response(text ? openMetrics(rows) : encodeTelemetry(rows), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": text
        ? "application/openmetrics-text; version=1.0.0; charset=utf-8"
        : "application/x-protobuf",
    },
  });
}

export async function operatorApi(request: Request, env: Env, url: URL) {
  const query = Object.fromEntries(url.searchParams);
  const path = url.pathname;
  if (request.method === "GET") {
    switch (path) {
      case "/api/v1/workspaces":
        return json(await workspaces(env));
      case "/api/v1/snapshot":
        return json(await getSnapshot(env, snapshotSchema.parse(query)));
      case "/api/v1/history":
        return json(await getHistory(env, historySchema.parse(query)));
      case "/api/v1/events":
        return json(await getEvents(env, eventsSchema.parse(query)));
      case "/api/v1/stream": {
        requireBrowserOrigin(request, env);
        const scope = snapshotSchema.parse({
          workspace: query.workspace,
        }).workspace;
        return env.STREAMS.get(env.STREAMS.idFromName(scope)).fetch(request);
      }
      case "/metrics":
      case "/api/v1/export/otlp":
        return exportApi(env, path, query.workspace ?? "global");
      case "/api/v1/export/archives":
      case "/api/v1/export/archive":
        return json(await exportArchives(env, url));
      default:
        return controlApi(request, env, path);
    }
  }
  if (request.method === "POST") {
    if (path === "/api/v1/workspaces") {
      return json(
        await registerWorkspace(
          env,
          workspaceSchema.parse(await readJson(request))
        ),
        201
      );
    }
    if (path === "/api/v1/clusters") {
      return json(
        await registerCluster(
          env,
          clusterSchema.parse(await readJson(request))
        ),
        201
      );
    }
    return controlApi(request, env, path);
  }
  throw new HttpError(405, "method unsupported");
}
