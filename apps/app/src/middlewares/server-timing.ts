import { createMiddleware } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { createTiming } from "../lib/server/server-timing";

// Measures a read and reports where it waited, including failed reads.
export const serverTimingMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const timing = createTiming();
  try {
    return await next({ context: { timing } });
  } finally {
    setResponseHeader("Server-Timing", timing.header());
  }
});
