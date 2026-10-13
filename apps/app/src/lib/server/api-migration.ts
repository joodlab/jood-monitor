import { requireCluster, unwrap } from "../../actions/clusters";
import { importRegistry } from "../../actions/migration";
import { clusterState, type Env } from "../../env";
import { idSchema } from "../../schemas/clusters";
import {
  archiveImportSchema,
  archivesImportSchema,
  historyImportSchema,
  observationImportSchema,
  registryImportSchema,
} from "../../schemas/migration";
import { hash } from "./crypto";
import { HttpError, json, readBody, readJson } from "./http";
import { telemetryAcknowledgment } from "./telemetry";

export async function migrationApi(request: Request, env: Env, url: URL) {
  if (env.MIGRATION_ENABLED !== "1") {
    throw new HttpError(403, "migration window closed");
  }
  if (request.method !== "POST") {
    throw new HttpError(405, "migration POST required");
  }
  if (url.pathname === "/api/v1/import/registry") {
    return json(
      await importRegistry(
        env,
        registryImportSchema.parse(await readJson(request))
      )
    );
  }
  const cluster = await requireCluster(
    env,
    idSchema.parse(url.searchParams.get("cluster"))
  );
  if (url.pathname === "/api/v1/import/archives") {
    const input = archivesImportSchema.parse(await readJson(request));
    return json(
      unwrap(
        await clusterState(env, cluster.id).command(
          cluster,
          "importArchives",
          input
        )
      )
    );
  }
  if (url.pathname === "/api/v1/import/archive") {
    const input = archiveImportSchema.parse(await readJson(request));
    return json(
      unwrap(
        await clusterState(env, cluster.id).command(
          cluster,
          "importArchive",
          input
        )
      )
    );
  }
  if (url.pathname === "/api/v1/import/history") {
    const input = historyImportSchema.parse(await readJson(request));
    return json(
      unwrap(
        await clusterState(env, cluster.id).command(
          cluster,
          "importHistory",
          input
        )
      )
    );
  }
  if (url.pathname === "/api/v1/import/observation") {
    const input = observationImportSchema.parse(await readJson(request));
    return json(
      unwrap(
        await clusterState(env, cluster.id).command(
          cluster,
          "restoreObservation",
          input
        )
      )
    );
  }
  if (url.pathname === "/api/v1/import/otlp") {
    if (request.headers.get("Content-Type") !== "application/x-protobuf") {
      throw new HttpError(415, "OTLP protobuf required");
    }
    const body = await readBody(request);
    const receipt = unwrap(
      await clusterState(env, cluster.id).ingest(
        cluster,
        body,
        request.headers.get("X-Jood-Batch-ID") ?? hash(body)
      )
    );
    return new Response(telemetryAcknowledgment(receipt.rejected), {
      headers: {
        "Content-Type": "application/x-protobuf",
        "Cache-Control": "no-store",
      },
    });
  }
  throw new HttpError(404, "migration route missing");
}
