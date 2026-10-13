import handler from "@tanstack/react-start/server-entry";
import { maintain } from "./actions/maintenance";
import type { ArchiveMessage } from "./contracts/types";
import { clusterState, type Env } from "./env";
import { apiError, dispatchApi } from "./lib/server/api";
import { requireOperator } from "./lib/server/auth";

// biome-ignore lint/performance/noBarrelFile: Cloudflare requires Durable Object exports in the Worker entry.
export { ClusterState } from "./durable-objects/cluster-state";
export { WorkspaceStream } from "./durable-objects/workspace-stream";

const trailingSlash = /\/$/;
export default {
  async fetch(request: Request, env: Env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/docs") && env.DOCS) {
        return env.DOCS.fetch(request);
      }
      if (
        (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) &&
        env.DOCS_URL
      ) {
        const target = new URL(env.DOCS_URL);
        target.pathname =
          target.pathname.replace(trailingSlash, "") + url.pathname.slice(5);
        target.search = url.search;
        return Response.redirect(target.toString(), 302);
      }
      const api = await dispatchApi(request, env);
      if (api) {
        return api;
      }
      requireOperator(request, env);
      const response = await handler.fetch(request);
      const secured = new Response(response.body, response);
      secured.headers.set("Cache-Control", "private, no-store");
      secured.headers.set("X-Content-Type-Options", "nosniff");
      secured.headers.set("X-Frame-Options", "DENY");
      secured.headers.set("Referrer-Policy", "same-origin");
      secured.headers.set("Vary", "Authorization");
      return secured;
    } catch (error) {
      return apiError(error);
    }
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await maintain(env);
  },
  async queue(batch: MessageBatch<ArchiveMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        await clusterState(env, message.body.clusterId).flush();
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, ArchiveMessage>;
