import { createFileRoute, isNotFound } from "@tanstack/react-router";
import { z } from "zod";
import { loadDocsPage } from "@/docs-source";

const slugsSchema = z.array(z.string().min(1).max(200)).max(20);

export const Route = createFileRoute("/api/docs/page")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const path = new URL(request.url).searchParams.get("path") ?? "";
        const parsed = slugsSchema.safeParse(path.split("/").filter(Boolean));
        if (!parsed.success) {
          return Response.json(
            { error: "invalid documentation path" },
            { status: 400 }
          );
        }
        try {
          return Response.json(await loadDocsPage(parsed.data));
        } catch (error) {
          if (isNotFound(error)) {
            return Response.json(
              { error: "documentation page missing" },
              { status: 404 }
            );
          }
          throw error;
        }
      },
    },
  },
});
