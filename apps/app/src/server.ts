import handler from "@tanstack/react-start/server-entry";
import { maintain } from "./actions/maintenance";
import type { ArchiveMessage } from "./contracts/types";
import { clusterState, type Env } from "./env";
import { apiError, dispatchApi } from "./lib/server/api";
import { requireOperator } from "./lib/server/auth";

// biome-ignore lint/performance/noBarrelFile: Cloudflare requires Durable Object exports in the Worker entry.
export { ClusterState } from "./durable-objects/cluster-state";
export { WorkspaceStream } from "./durable-objects/workspace-stream";

export default {
  async fetch(request: Request, env: Env) {
    try {
      const url = new URL(request.url);
      const publicDocs =
        url.pathname === "/docs" ||
        url.pathname.startsWith("/docs/") ||
        url.pathname === "/api/docs/page" ||
        url.pathname === "/api/search";
      if (publicDocs) {
        return await handler.fetch(request);
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
