import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  worker: {
    name: process.env.MONITOR_DOCS_WORKER_NAME ?? "jood-monitor-docs",
    entrypoint: "@tanstack/react-start/server-entry",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: true,
    domains: process.env.MONITOR_DOCS_DOMAIN
      ? [process.env.MONITOR_DOCS_DOMAIN]
      : [],
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: false },
    },
    env: { RELEASE: bindings.versionMetadata() },
  },
});
