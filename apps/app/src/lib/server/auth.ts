import { getMachineCluster } from "../../data-access/clusters";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { hash, secretMatches } from "./crypto";
import { HttpError } from "./http";

function operatorOrigin(request: Request, env: Env) {
  const serving = new URL(request.url);
  const configured = new URL(env.APP_ORIGIN || serving.origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    configured.hostname
  );
  if (
    configured.origin !== serving.origin ||
    (configured.protocol !== "https:" &&
      !(loopback && configured.protocol === "http:")) ||
    configured.username ||
    configured.password ||
    configured.pathname !== "/" ||
    configured.search ||
    configured.hash
  ) {
    throw new HttpError(503, "operator origin configuration unavailable");
  }
  return configured.origin;
}

export function requireOperatorConfiguration(request: Request, env: Env) {
  if (
    !(env.OPERATOR_USER && env.OPERATOR_PASSWORD) ||
    env.OPERATOR_PASSWORD.length < 16
  ) {
    throw new HttpError(503, "operator configuration unavailable");
  }
  return operatorOrigin(request, env);
}

export function requireBrowserOrigin(request: Request, env: Env) {
  if (request.headers.get("Origin") !== operatorOrigin(request, env)) {
    throw new HttpError(403, "same-origin browser connection required");
  }
}

export function requireOperator(request: Request, env: Env) {
  const origin = requireOperatorConfiguration(request, env);
  const auth = request.headers.get("Authorization") ?? "";
  let username = "",
    password = "";
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
      const colon = decoded.indexOf(":");
      if (colon >= 0) {
        username = decoded.slice(0, colon);
        password = decoded.slice(colon + 1);
      }
    } catch {
      /* invalid credentials have the same outcome as missing credentials */
    }
  }
  const userOk = secretMatches(username, env.OPERATOR_USER);
  const passwordOk = secretMatches(password, env.OPERATOR_PASSWORD);
  if (!(userOk && passwordOk)) {
    throw new HttpError(401, "authentication required");
  }
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    (request.headers.get("Origin") !== origin ||
      request.headers.get("X-Jood-CSRF") !== "1")
  ) {
    throw new HttpError(403, "origin and CSRF header required");
  }
  if (
    (env.MIGRATION_ENABLED === "1" || env.RECOVERY_ENABLED === "1") &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !new URL(request.url).pathname.startsWith("/api/v1/import/")
  ) {
    throw new HttpError(
      503,
      "migration or recovery window; operator writes closed"
    );
  }
}

export async function requireMachine(request: Request, env: Env) {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length > 512) {
    throw new HttpError(401, "invalid machine credential");
  }
  const cluster = await getMachineCluster(getDb(env.DB), hash(header.slice(7)));
  if (!cluster) {
    throw new HttpError(401, "invalid machine credential");
  }
  return cluster;
}
