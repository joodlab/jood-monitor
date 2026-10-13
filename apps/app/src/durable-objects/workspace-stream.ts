import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export class WorkspaceStream extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    // Reconnect always resynchronizes scoped saved state; missed notifications cannot hide updates.
    pair[1].send(JSON.stringify({ type: "reload" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  publish(clusterId: string) {
    const data = JSON.stringify({ type: "change", clusterId });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(data);
      } catch {
        socket.close(1011, "reconnect");
      }
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message !== "ping") {
      socket.close(1008, "notifications only");
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    socket.close(code, reason);
  }
}
