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

export default defineConfig(({ mode }) => ({
  accountId: config.accountId,
  worker: {
    name,
    entrypoint: "./src/server.ts",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: true,
    domains: process.env.MONITOR_DOMAIN ? [process.env.MONITOR_DOMAIN] : [],
    exports: {
      ClusterState: workerExports.durableObject({ storage: "sqlite" }),
      WorkspaceStream: workerExports.durableObject({ storage: "sqlite" }),
    },
    triggers: [
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
      ...(process.env.MONITOR_DOCS_URL
        ? { DOCS_URL: bindings.text(process.env.MONITOR_DOCS_URL) }
        : {}),
      VERSION: bindings.text("0.1.0"),
      RELEASE: bindings.versionMetadata(),
    },
  },
}));
