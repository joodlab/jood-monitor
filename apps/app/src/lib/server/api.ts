import { ZodError } from "zod";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { machineApi } from "./api-machine";
import { migrationApi } from "./api-migration";
import { operatorApi } from "./api-operator";
import { requireOperator, requireOperatorConfiguration } from "./auth";
import { HttpError, json } from "./http";

export function apiError(error: unknown) {
  let status = 503,
    message = "storage unavailable; retry";
  if (error instanceof HttpError) {
    status = error.status;
    message = error.message;
  } else if (error instanceof ZodError) {
    status = 400;
    message = "invalid request";
  }
  const response = json({ error: message }, status);
  if (status === 401) {
    response.headers.set(
      "WWW-Authenticate",
      'Basic realm="Jood Monitor", charset="UTF-8"'
    );
  }
  if (status === 429 || status === 503) {
    response.headers.set("Retry-After", "60");
  }
  return response;
}

export async function dispatchApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/health") {
    return json({
      status: "alive",
      version: env.VERSION,
      release: env.RELEASE ?? null,
      runtime: "cloudflare-workers",
    });
  }
  if (path === "/ready") {
    requireOperatorConfiguration(request, env);
    await getDb(env.DB).orm.Workspace.select("id").limit(1).all();
    return json({
      status: "ready",
      version: env.VERSION,
      release: env.RELEASE ?? null,
    });
  }
  if (path.startsWith("/machine/v1/") || path === "/v1/metrics") {
    return machineApi(request, env, path);
  }
  if (!path.startsWith("/api/v1/") && path !== "/metrics") {
    return null;
  }
  requireOperator(request, env);
  if (path.startsWith("/api/v1/import/")) {
    return migrationApi(request, env, url);
  }
  return operatorApi(request, env, url);
}
