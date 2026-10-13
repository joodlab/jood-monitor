import { env as bindings } from "cloudflare:workers";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { Env } from "../env";
import { requireOperator } from "../lib/server/auth";

export const operatorMiddleware = createMiddleware({ type: "function" }).server(
  ({ next }) => {
    const env = bindings as unknown as Env;
    requireOperator(getRequest(), env);
    return next({ context: { env } });
  }
);
