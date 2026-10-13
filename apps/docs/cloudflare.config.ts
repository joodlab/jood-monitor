import { bindings, defineConfig } from "cf/config";

function hubOrigin() {
  const value = process.env.MONITOR_HUB_URL;
  if (!value) {
    return "";
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "MONITOR_HUB_URL must be an HTTPS origin without credentials"
    );
  }
  return url.origin;
}

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
    env: {
      RELEASE: bindings.versionMetadata(),
      HUB_URL: bindings.text(hubOrigin()),
    },
  },
});
