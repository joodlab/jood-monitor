import { notFound } from "@tanstack/react-router";
import { createServerOnlyFn } from "@tanstack/react-start";
import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";

export const source = loader({
  baseUrl: "/docs",
  plugins: [lucideIconsPlugin()],
  source: docs.toFumadocsSource(),
});

export const loadDocsPage = createServerOnlyFn(async (slugs: string[]) => {
  const page = source.getPage(slugs);
  if (!page) {
    throw notFound();
  }
  return {
    description: page.data.description,
    pageTree: await source.serializePageTree(source.getPageTree()),
    path: page.path,
    title: page.data.title,
  };
});
