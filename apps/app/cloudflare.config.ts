import {
  bindings,
  defineConfig,
  triggers,
  exports as workerExports,
} from "cf/config";
import { settings } from "../../scripts/cloudflare/settings.ts";
import type { ArchiveMessage } from "./src/contracts/types";

const config = settings();
const { name, queue: history } = config;
const routeHost = process.env.MONITOR_ROUTE_HOSTNAME;
if (routeHost) {
  const origin = new URL(`https://${routeHost}`);
  if (
    origin.host !== routeHost ||
    origin.port ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error("MONITOR_ROUTE_HOSTNAME must be a bare DNS hostname");
  }
  if (process.env.MONITOR_DOMAIN) {
    throw new Error("Choose MONITOR_DOMAIN or MONITOR_ROUTE_HOSTNAME");
  }
}

export default defineConfig(({ mode }) => ({
  accountId: config.accountId,
  worker: {
    name,
    entrypoint: "./src/server.ts",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    limits: { cpuMs: 1000 },
    workersDev: true,
    domains: process.env.MONITOR_DOMAIN ? [process.env.MONITOR_DOMAIN] : [],
    exports: {
      ClusterState: workerExports.durableObject({ storage: "sqlite" }),
      WorkspaceStream: workerExports.durableObject({ storage: "sqlite" }),
    },
    triggers: [
      ...(routeHost
        ? [
            triggers.fetch({
              pattern: `${routeHost}/*`,
              ...(process.env.MONITOR_ROUTE_ZONE
                ? { zone: process.env.MONITOR_ROUTE_ZONE }
                : {}),
            }),
          ]
        : []),
      triggers.scheduled({ schedule: "*/5 * * * *" }),
      triggers.queue({
        name: history,
        maxBatchSize: 10,
        maxConcurrency: 2,
        maxRetries: 10,
        deadLetterQueue: config.deadLetter,
      }),
    ],
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: false },
    },
    env: {
      DB: bindings.d1({
        name: config.databaseName,
        id: mode === "development" ? config.localDatabaseId : config.databaseId,
      }),
      ARCHIVES: bindings.r2({ name: config.bucket }),
      CLUSTERS: bindings.durableObject({
        worker: name,
        exportName: "ClusterState",
      }),
      STREAMS: bindings.durableObject({
        worker: name,
        exportName: "WorkspaceStream",
      }),
      HISTORY: bindings.queue<ArchiveMessage>({ name: history }),
      OPERATOR_USER: bindings.secret(),
      OPERATOR_PASSWORD: bindings.secret(),
      ...(process.env.MONITOR_MIGRATION === "1"
        ? { MIGRATION_ENABLED: bindings.text("1") }
        : {}),
      ...(process.env.MONITOR_RECOVERY === "1"
        ? { RECOVERY_ENABLED: bindings.text("1") }
        : {}),
      VERSION: bindings.text("0.1.1"),
      RELEASE: bindings.versionMetadata(),
    },
  },
}));
