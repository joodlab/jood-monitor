import { enrollCluster, unwrap } from "../../actions/clusters";
import { clusterState, type Env } from "../../env";
import { enrollmentSchema } from "../../schemas/clusters";
import { requireMachine } from "./auth";
import { hash } from "./crypto";
import { HttpError, json, readBody, readJson } from "./http";
import { telemetryAcknowledgment } from "./telemetry";

export async function machineApi(request: Request, env: Env, path: string) {
  if (env.MIGRATION_ENABLED === "1" && request.method !== "GET") {
    throw new HttpError(
      503,
      "isolated migration target; live ingestion closed"
    );
  }
  if (path === "/machine/v1/enroll" && request.method === "POST") {
    if (env.RECOVERY_ENABLED === "1") {
      throw new HttpError(503, "recovery window; enrollment closed");
    }
    const input = enrollmentSchema.parse(await readJson(request));
    return json(
      await enrollCluster(
        env,
        input.clusterId,
        request.headers.get("Authorization") ?? ""
      )
    );
  }
  const cluster = await requireMachine(request, env);
  const state = clusterState(env, cluster.id);
  if (path === "/v1/metrics" && request.method === "POST") {
    if (request.headers.get("Content-Type") !== "application/x-protobuf") {
      throw new HttpError(415, "OTLP/HTTP protobuf required");
    }
    const body = await readBody(request);
    const batchId = request.headers.get("X-Jood-Batch-ID") ?? hash(body);
    const receipt = unwrap(await state.ingest(cluster, body, batchId));
    return new Response(telemetryAcknowledgment(receipt.rejected), {
      headers: {
        "Content-Type": "application/x-protobuf",
        "Cache-Control": "no-store",
      },
    });
  }
  if (path === "/machine/v1/profile" && request.method === "GET") {
    return json(unwrap(await state.command(cluster, "getProfile", null)));
  }
  const routes: Record<string, string> = {
    "PUT /machine/v1/inventory": "inventory",
    "POST /machine/v1/heartbeat": "heartbeat",
    "POST /machine/v1/lifecycle": "lifecycle",
  };
  const kind = routes[`${request.method} ${path}`];
  if (!kind) {
    throw new HttpError(404, "machine route missing");
  }
  return json(
    unwrap(await state.command(cluster, kind, await readJson(request)))
  );
}
